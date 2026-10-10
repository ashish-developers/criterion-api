// GST tax invoices (acceptance criterion: an invoice for every paid order).
// Lines carry HSN, taxable value and CGST/SGST or IGST from the order's tax snapshot,
// so later catalogue changes never alter an issued invoice.
const { Op } = require("sequelize");
const { Order, OrderItem, Invoice, User, Company } = require("../Models");
const ApiError = require("../Utils/ApiError");
const { nextNumber } = require("../Utils/numbering");
const settingsService = require("./settingsService");
const engine = require("./pricingEngine");

async function generate(orderId, { transaction } = {}) {
  const existing = await Invoice.findOne({ where: { order_id: orderId }, transaction });
  if (existing) return existing;
  const order = await Order.findByPk(orderId, { transaction });
  const items = await OrderItem.findAll({ where: { order_id: orderId, unit_price_paise: { [Op.gt]: 0 } }, order: [["line_no", "ASC"]], transaction });
  const seller = await settingsService.get("seller");
  const shippingCfg = await settingsService.get("shipping");
  const customer = await User.findByPk(order.user_id, { transaction });
  const company = order.company_id ? await Company.findByPk(order.company_id, { transaction }) : null;
  const interstate = order.shipping_address.state.trim().toLowerCase() !== seller.state.trim().toLowerCase();

  const lines = items.map((item) => {
    const tax = engine.gst(item.taxable_paise, Number(item.gst_rate), interstate);
    return {
      lineNo: item.line_no,
      description: `${item.product_snapshot.name}${item.product_snapshot.attributes ? ` (${Object.values(item.product_snapshot.attributes).filter((v) => String(v).length < 25).join(", ")})` : ""}`,
      sku: item.product_snapshot.sku,
      hsn: item.hsn_code,
      quantity: item.quantity,
      unitPricePaise: item.unit_price_paise,
      discountPaise: item.discount_paise,
      taxablePaise: item.taxable_paise,
      gstRate: Number(item.gst_rate),
      cgstPaise: tax.cgst,
      sgstPaise: tax.sgst,
      igstPaise: tax.igst,
      totalPaise: item.taxable_paise + tax.total,
    };
  });
  if (order.shipping_paise > 0) {
    const tax = engine.gst(order.shipping_paise, shippingCfg.gst_rate, interstate);
    lines.push({
      lineNo: lines.length + 1,
      description: "Shipping and handling",
      hsn: "996812",
      quantity: 1,
      unitPricePaise: order.shipping_paise,
      discountPaise: 0,
      taxablePaise: order.shipping_paise,
      gstRate: shippingCfg.gst_rate,
      cgstPaise: tax.cgst,
      sgstPaise: tax.sgst,
      igstPaise: tax.igst,
      totalPaise: order.shipping_paise + tax.total,
    });
  }
  const sum = (k) => lines.reduce((s, l) => s + l[k], 0);
  const creditDays = { credit_15: 15, credit_30: 30 }[order.payment_terms];
  return Invoice.create(
    {
      invoice_number: await nextNumber("invoice", transaction),
      order_id: order.id,
      seller,
      buyer: {
        name: company ? company.legal_name || company.name : customer.name,
        contact: customer.name,
        email: customer.email,
        gstin: order.gstin || null,
        billing_address: order.billing_address,
        shipping_address: order.shipping_address,
      },
      place_of_supply: order.shipping_address.state,
      is_interstate: interstate,
      lines,
      taxable_paise: sum("taxablePaise"),
      cgst_paise: sum("cgstPaise"),
      sgst_paise: sum("sgstPaise"),
      igst_paise: sum("igstPaise"),
      total_paise: sum("totalPaise"),
      po_number: order.po_number,
      issued_at: new Date(),
      due_date: creditDays ? new Date(Date.now() + creditDays * 86400 * 1000).toISOString().slice(0, 10) : null,
    },
    { transaction }
  );
}

async function forOrder(auth, orderId) {
  const orderService = require("./orderService");
  const order = await orderService.loadVisible(auth, orderId);
  const isBuyer = order.user_id === auth.user.id || (order.company_id && order.company_id === auth.companyId);
  if (!isBuyer && !auth.permissions.has("payments.view") && !auth.permissions.has("orders.view")) throw ApiError.forbidden();
  const invoice = await Invoice.findOne({ where: { order_id: order.id } });
  if (!invoice) throw ApiError.notFound("An invoice is issued once the order is paid");
  return { ...invoice.toJSON(), order_number: order.order_number, amount_paid_paise: order.amount_paid_paise, payment_terms: order.payment_terms };
}

async function listForCompany(companyId) {
  const [rows] = await Invoice.sequelize.query(
    `SELECT i.id, i.invoice_number, i.issued_at, i.due_date, i.total_paise, i.po_number, o.id AS order_id, o.order_number,
            o.amount_paid_paise, o.payment_status, o.payment_terms
       FROM invoices i JOIN orders o ON o.id = i.order_id
      WHERE o.company_id = :companyId ORDER BY i.issued_at DESC`,
    { replacements: { companyId } }
  );
  return rows;
}

module.exports = { generate, forOrder, listForCompany };
