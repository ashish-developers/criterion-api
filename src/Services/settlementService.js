// Vendor settlements (Section 8.5): lines delivered and past the complaint window.
//   payout = item value - commission - fees - adjustments - statutory deductions (TCS/TDS)
// TCS/TDS percentages come from settings and must be confirmed with a tax adviser.
const { Op } = require("sequelize");
const { sequelize, Settlement, SettlementLine, Commission, Vendor, OrderItem, Order } = require("../Models");
const ApiError = require("../Utils/ApiError");
const { nextNumber } = require("../Utils/numbering");
const settingsService = require("./settingsService");
const productionService = require("./productionService");

async function preview(vendorId) {
  return Commission.findAll({
    where: { vendor_id: vendorId, settlement_id: null, eligible_at: { [Op.ne]: null, [Op.lte]: new Date() } },
    include: [{ model: OrderItem, as: "orderItem", attributes: ["id", "product_snapshot", "quantity", "order_id", "delivered_at"] }],
    order: [["eligible_at", "ASC"]],
  });
}

async function generate(auth, { vendorId }) {
  return sequelize.transaction(async (transaction) => {
    const vendor = await Vendor.findByPk(vendorId, { transaction });
    if (!vendor) throw ApiError.notFound("Vendor not found");
    const commissions = await Commission.findAll({
      where: { vendor_id: vendorId, settlement_id: null, eligible_at: { [Op.ne]: null, [Op.lte]: new Date() } },
      include: [{ model: OrderItem, as: "orderItem", attributes: ["id", "delivered_at"] }],
      transaction,
      lock: { level: transaction.LOCK.UPDATE, of: Commission },
    });
    if (!commissions.length) throw ApiError.unprocessable("No delivered lines are due for settlement yet", "NOTHING_TO_SETTLE");
    const cfg = await settingsService.get("marketplace");
    let gross = 0;
    let commissionTotal = 0;
    let adjustments = 0;
    let marketplaceValue = 0;
    for (const c of commissions) {
      gross += c.item_value_paise;
      commissionTotal += c.commission_paise;
      adjustments += c.adjustment_paise;
      if (c.model === "marketplace") marketplaceValue += c.item_value_paise;
    }
    const fees = Math.round((marketplaceValue * cfg.payment_gateway_fee_pct) / 100);
    const tcs = Math.round((marketplaceValue * cfg.tcs_pct) / 100);
    const tds = Math.round((marketplaceValue * cfg.tds_pct) / 100);
    const dates = commissions.map((c) => c.orderItem?.delivered_at || c.eligible_at).sort((a, b) => a - b);
    const settlement = await Settlement.create(
      {
        settlement_number: await nextNumber("settlement", transaction),
        vendor_id: vendorId,
        period_start: dates[0].toISOString().slice(0, 10),
        period_end: dates[dates.length - 1].toISOString().slice(0, 10),
        gross_paise: gross,
        commission_paise: commissionTotal,
        fees_paise: fees,
        adjustments_paise: adjustments,
        tcs_paise: tcs,
        tds_paise: tds,
        payout_paise: gross - commissionTotal - fees - adjustments - tcs - tds,
        status: "draft",
        created_by: auth.user.id,
      },
      { transaction }
    );
    for (const c of commissions) {
      await SettlementLine.create(
        {
          settlement_id: settlement.id,
          order_item_id: c.order_item_id,
          item_value_paise: c.item_value_paise,
          commission_paise: c.commission_paise,
          adjustment_paise: c.adjustment_paise,
          net_paise: c.item_value_paise - c.commission_paise - c.adjustment_paise,
        },
        { transaction }
      );
      await c.update({ settlement_id: settlement.id }, { transaction });
    }
    return settlement;
  });
}

async function setStatus(auth, id, { status, reference }) {
  const settlement = await Settlement.findByPk(id);
  if (!settlement) throw ApiError.notFound("Settlement not found");
  const allowed = { draft: ["approved"], approved: ["paid"] };
  if (!(allowed[settlement.status] || []).includes(status)) throw ApiError.conflict(`A ${settlement.status} settlement cannot be marked ${status}`, "SETTLEMENT_STATE");
  if (status === "paid" && !reference) throw ApiError.unprocessable("Enter the payout reference (UTR)", "REFERENCE_REQUIRED");
  await settlement.update({ status, payout_reference: reference || settlement.payout_reference, paid_at: status === "paid" ? new Date() : null });
  if (status === "paid") {
    await productionService.notifyVendor(settlement.vendor_id, {
      type: "settlement_paid",
      title: `Settlement ${settlement.settlement_number} paid`,
      body: `₹${(settlement.payout_paise / 100).toFixed(2)} sent. Reference ${reference}.`,
      link: `/vendor/settlements/${settlement.id}`,
    });
  }
  return settlement;
}

async function list({ vendorId, status, page = 1, limit = 20 }) {
  const where = {};
  if (vendorId) where.vendor_id = vendorId;
  if (status) where.status = status;
  const { rows, count } = await Settlement.findAndCountAll({
    where,
    include: [{ model: Vendor, as: "vendor", attributes: ["id", "business_name"] }],
    order: [["created_at", "DESC"]],
    limit,
    offset: (page - 1) * limit,
  });
  return { items: rows, total: count };
}

async function detail(id, { vendorId } = {}) {
  const settlement = await Settlement.findByPk(id, { include: [{ model: Vendor, as: "vendor", attributes: ["id", "business_name", "gstin", "pan", "bank_account_last4", "bank_ifsc"] }] });
  if (!settlement || (vendorId && settlement.vendor_id !== vendorId)) throw ApiError.notFound("Settlement not found");
  const lines = await SettlementLine.findAll({ where: { settlement_id: settlement.id } });
  const items = await OrderItem.findAll({ where: { id: lines.map((l) => l.order_item_id) }, include: [{ model: Order, as: "order", attributes: ["id", "order_number"] }] });
  const byId = new Map(items.map((i) => [i.id, i]));
  return {
    ...settlement.toJSON(),
    lines: lines.map((l) => {
      const item = byId.get(l.order_item_id);
      return { ...l.toJSON(), orderNumber: item?.order?.order_number, product: item?.product_snapshot?.name, quantity: item?.quantity, deliveredAt: item?.delivered_at };
    }),
  };
}

// Vendor's view of what is earned but not yet settled.
async function pendingEarnings(vendorId) {
  const [rows] = await sequelize.query(
    `SELECT COALESCE(sum(vendor_earning_paise - adjustment_paise) FILTER (WHERE settlement_id IS NULL AND eligible_at IS NOT NULL), 0)::bigint AS due,
            COALESCE(sum(vendor_earning_paise - adjustment_paise) FILTER (WHERE settlement_id IS NULL AND eligible_at IS NULL), 0)::bigint AS in_window
       FROM commissions WHERE vendor_id = :vendorId`,
    { replacements: { vendorId } }
  );
  return { duePaise: Number(rows[0].due), inComplaintWindowPaise: Number(rows[0].in_window) };
}

module.exports = { preview, generate, setStatus, list, detail, pendingEarnings };
