// Visiting card administration: dashboard, reports, customer lists, quantity-slab pricing,
// printing specifications and module settings. Money figures are only returned to staff who
// may see them (vcOrderService.canSeeMoney).
const { UniqueConstraintError } = require("sequelize");
const { sequelize, VcPriceSlab, VcPrintOption } = require("../Models");
const ApiError = require("../Utils/ApiError");
const settingsService = require("./settingsService");
const pricing = require("./vcPricing");
const orders = require("./vcOrderService");

const n = (x) => Number(x || 0);

async function dashboard(auth) {
  const money = orders.canSeeMoney(auth);
  const [[kpi]] = await sequelize.query(
    `SELECT count(*) FILTER (WHERE placed_at >= date_trunc('day', now()))::int AS today,
            count(*) FILTER (WHERE placed_at >= date_trunc('month', now()))::int AS month,
            count(*) FILTER (WHERE status = 'pending')::int AS awaiting_payment,
            count(*) FILTER (WHERE status = 'artwork_review' AND artwork_status = 'submitted')::int AS awaiting_review,
            count(*) FILTER (WHERE status = 'artwork_review' AND artwork_status = 'rejected')::int AS awaiting_customer,
            count(*) FILTER (WHERE status = 'approved')::int AS approved,
            count(*) FILTER (WHERE status = 'in_production')::int AS in_production,
            count(*) FILTER (WHERE status = 'dispatched')::int AS dispatched,
            COALESCE(sum(total_quantity) FILTER (WHERE payment_status = 'paid' AND placed_at >= date_trunc('month', now())), 0)::bigint AS cards_month,
            COALESCE(sum(total_paise) FILTER (WHERE payment_status = 'paid' AND placed_at >= date_trunc('month', now())), 0)::bigint AS revenue_month,
            COALESCE(sum(total_paise) FILTER (WHERE payment_status = 'paid'), 0)::bigint AS revenue_all
       FROM vc_orders`
  );
  const [byStatus] = await sequelize.query(`SELECT status, count(*)::int AS count FROM vc_orders GROUP BY status`);
  const [[templates]] = await sequelize.query(
    `SELECT count(*) FILTER (WHERE status = 'published')::int AS published, count(*)::int AS total FROM vc_templates WHERE deleted_at IS NULL`
  );
  const [[drafts]] = await sequelize.query(`SELECT count(*)::int AS open FROM vc_designs WHERE deleted_at IS NULL AND status = 'draft'`);
  const recent = await orders.staffList(auth, { page: 1, limit: 8 });
  const review = await orders.staffList(auth, { page: 1, limit: 6, status: "artwork_review", artworkStatus: "submitted" });
  return {
    kpis: {
      ordersToday: kpi.today,
      ordersThisMonth: kpi.month,
      awaitingPayment: kpi.awaiting_payment,
      awaitingReview: kpi.awaiting_review,
      awaitingCustomer: kpi.awaiting_customer,
      approved: kpi.approved,
      inProduction: kpi.in_production,
      dispatched: kpi.dispatched,
      cardsThisMonth: n(kpi.cards_month),
      ...(money ? { revenueThisMonthPaise: n(kpi.revenue_month), revenueAllTimePaise: n(kpi.revenue_all) } : {}),
      publishedTemplates: templates.published,
      templates: templates.total,
      openDrafts: drafts.open,
    },
    byStatus: Object.fromEntries(byStatus.map((r) => [r.status, r.count])),
    recentOrders: recent.items,
    reviewQueue: review.items,
  };
}

function range(q) {
  const to = q.to ? new Date(`${q.to}T00:00:00`) : new Date();
  const end = new Date(to.getTime() + (q.to ? 86400000 : 0));
  const from = q.from ? new Date(`${q.from}T00:00:00`) : new Date(end.getTime() - 365 * 86400000);
  return { from, to: end };
}

async function reports(auth, q) {
  const money = orders.canSeeMoney(auth);
  const r = range(q);
  const rep = { replacements: { from: r.from, to: r.to } };
  const [monthly] = await sequelize.query(
    `SELECT to_char(date_trunc('month', placed_at), 'YYYY-MM') AS month,
            count(*)::int AS orders,
            count(*) FILTER (WHERE payment_status = 'paid')::int AS paid_orders,
            COALESCE(sum(total_quantity) FILTER (WHERE payment_status = 'paid'), 0)::bigint AS cards,
            COALESCE(sum(total_paise) FILTER (WHERE payment_status = 'paid'), 0)::bigint AS revenue
       FROM vc_orders WHERE placed_at >= :from AND placed_at < :to
      GROUP BY 1 ORDER BY 1`,
    rep
  );
  const [byType] = await sequelize.query(
    `SELECT customer_type, count(*)::int AS orders, COALESCE(sum(total_quantity), 0)::bigint AS cards,
            COALESCE(sum(total_paise) FILTER (WHERE payment_status = 'paid'), 0)::bigint AS revenue,
            COALESCE(round(avg(total_quantity)), 0)::int AS avg_quantity
       FROM vc_orders WHERE placed_at >= :from AND placed_at < :to AND status <> 'cancelled' GROUP BY 1`,
    rep
  );
  const [topTemplates] = await sequelize.query(
    `SELECT template_snapshot->>'name' AS name, count(*)::int AS orders, COALESCE(sum(total_quantity), 0)::bigint AS cards,
            COALESCE(sum(total_paise) FILTER (WHERE payment_status = 'paid'), 0)::bigint AS revenue
       FROM vc_orders WHERE placed_at >= :from AND placed_at < :to AND status <> 'cancelled'
      GROUP BY 1 ORDER BY orders DESC, cards DESC LIMIT 10`,
    rep
  );
  const [options] = await sequelize.query(
    `SELECT o->>'group' AS group_code, o->>'name' AS name, count(*)::int AS orders
       FROM vc_orders, jsonb_array_elements(print_options) o
      WHERE placed_at >= :from AND placed_at < :to AND status <> 'cancelled'
      GROUP BY 1, 2 ORDER BY 1, orders DESC`,
    rep
  );
  const [[funnel]] = await sequelize.query(
    `SELECT (SELECT count(*) FROM vc_designs WHERE created_at >= :from AND created_at < :to)::int AS designs,
            (SELECT count(DISTINCT design_id) FROM vc_orders WHERE placed_at >= :from AND placed_at < :to)::int AS ordered_designs,
            (SELECT count(*) FROM vc_orders WHERE placed_at >= :from AND placed_at < :to AND payment_status = 'paid')::int AS paid_orders,
            (SELECT count(*) FROM vc_orders WHERE placed_at >= :from AND placed_at < :to AND status = 'cancelled')::int AS cancelled,
            (SELECT COALESCE(round(avg(EXTRACT(EPOCH FROM (dispatched_at - paid_at)) / 86400)::numeric, 1), 0)
               FROM vc_orders WHERE dispatched_at IS NOT NULL AND paid_at IS NOT NULL AND placed_at >= :from AND placed_at < :to) AS avg_days_to_dispatch`,
    rep
  );
  const strip = (row, key = "revenue") => {
    const out = { ...row };
    if (key in out) out[key] = money ? n(out[key]) : undefined;
    if ("cards" in out) out.cards = n(out.cards);
    return out;
  };
  return {
    from: r.from.toISOString().slice(0, 10),
    to: new Date(r.to.getTime() - 86400000).toISOString().slice(0, 10),
    showMoney: money,
    monthly: monthly.map((m) => strip(m)),
    byCustomerType: byType.map((t) => strip(t)),
    topTemplates: topTemplates.map((t) => strip(t)),
    printOptions: options,
    funnel: { designs: funnel.designs, orderedDesigns: funnel.ordered_designs, paidOrders: funnel.paid_orders, cancelled: funnel.cancelled, avgDaysToDispatch: Number(funnel.avg_days_to_dispatch) },
  };
}

async function customers(auth, type, q) {
  const money = orders.canSeeMoney(auth);
  const term = q.q ? `%${q.q.replace(/[%_\\]/g, "\\$&")}%` : null;
  const limit = q.limit || 20;
  const offset = ((q.page || 1) - 1) * limit;
  const sql =
    type === "corporate"
      ? `SELECT c.id, c.name, c.gstin, c.billing_email AS email, c.status,
                count(DISTINCT o.id)::int AS orders, COALESCE(sum(o.total_quantity), 0)::bigint AS cards,
                COALESCE(sum(o.card_count), 0)::int AS people,
                COALESCE(sum(o.total_paise) FILTER (WHERE o.payment_status = 'paid'), 0)::bigint AS spend,
                max(o.placed_at) AS last_order_at,
                (SELECT count(*) FROM vc_designs d WHERE d.company_id = c.id AND d.deleted_at IS NULL)::int AS designs,
                (SELECT count(*) FROM vc_designs d WHERE d.company_id = c.id AND d.approved_at IS NOT NULL AND d.deleted_at IS NULL)::int AS approved_designs,
                count(*) OVER()::int AS total
           FROM companies c JOIN vc_orders o ON o.company_id = c.id AND o.status <> 'cancelled'
          WHERE (CAST(:term AS text) IS NULL OR c.name ILIKE :term OR c.gstin ILIKE :term)
          GROUP BY c.id ORDER BY last_order_at DESC LIMIT :limit OFFSET :offset`
      : `SELECT u.id, u.name, u.email, u.phone, u.status,
                count(DISTINCT o.id)::int AS orders, COALESCE(sum(o.total_quantity), 0)::bigint AS cards,
                COALESCE(sum(o.total_paise) FILTER (WHERE o.payment_status = 'paid'), 0)::bigint AS spend,
                max(o.placed_at) AS last_order_at,
                (SELECT count(*) FROM vc_designs d WHERE d.user_id = u.id AND d.customer_type = 'individual' AND d.deleted_at IS NULL)::int AS designs,
                count(*) OVER()::int AS total
           FROM users u JOIN vc_orders o ON o.user_id = u.id AND o.customer_type = 'individual' AND o.status <> 'cancelled'
          WHERE (CAST(:term AS text) IS NULL OR u.name ILIKE :term OR u.email ILIKE :term)
          GROUP BY u.id ORDER BY last_order_at DESC LIMIT :limit OFFSET :offset`;
  const [rows] = await sequelize.query(sql, { replacements: { term, limit, offset } });
  return {
    items: rows.map(({ total, spend, cards, ...r }) => ({ ...r, cards: n(cards), ...(money ? { spendPaise: n(spend) } : {}) })),
    total: rows[0]?.total || 0,
  };
}

// ---------------------------------------------------------------- pricing slabs
function presentSlab(s) {
  return { id: s.id, minQty: s.min_qty, maxQty: s.max_qty, unitPricePaise: s.unit_price_paise, label: s.label };
}

async function pricingTable() {
  const slabs = await VcPriceSlab.findAll({ order: [["min_qty", "ASC"]] });
  const settings = await settingsService.get("visiting_cards");
  return { slabs: slabs.map(presentSlab), minOrderQty: settings.min_order_qty, doubleSidedPerCardPaise: settings.double_sided_per_card_paise, gstRate: settings.gst_rate };
}

/** Replaces the whole slab table at once, so it is never saved half-edited. */
async function saveSlabs(input) {
  const settings = await settingsService.get("visiting_cards");
  const rows = input.map((s) => ({ min_qty: s.minQty, max_qty: s.maxQty ?? null, unit_price_paise: s.unitPrice, label: s.label || null }));
  if (rows.some((r) => r.unit_price_paise <= 0)) throw ApiError.unprocessable("Every slab needs a price above zero", "VALIDATION_FAILED", { slabs: "Price required" });
  const problems = pricing.slabProblems(rows, settings.min_order_qty);
  if (problems.length) throw ApiError.unprocessable(problems[0], "SLABS_INVALID", { slabs: problems.join(". "), problems });
  const before = (await pricingTable()).slabs;
  await sequelize.transaction(async (transaction) => {
    await VcPriceSlab.destroy({ where: {}, transaction });
    await VcPriceSlab.bulkCreate(rows.sort((a, b) => a.min_qty - b.min_qty), { transaction });
  });
  return { before, after: (await pricingTable()).slabs };
}

// ---------------------------------------------------------------- print options
async function listOptions() {
  return (await orders.printOptions({ activeOnly: false })).map(orders.presentOption);
}

async function saveOption(data, id) {
  try {
    return await sequelize.transaction(async (transaction) => {
      const existing = id ? await VcPrintOption.findByPk(id, { transaction, lock: transaction.LOCK.UPDATE }) : null;
      if (id && !existing) throw ApiError.notFound("Printing option not found");
      if (existing && existing.group_code !== data.groupCode) {
        throw ApiError.unprocessable("An option cannot move to another group. Add a new option instead.", "VALIDATION_FAILED", { groupCode: "Cannot change" });
      }
      const isActive = data.isActive ?? existing?.is_active ?? true;
      const isDefault = Boolean(data.isDefault ?? existing?.is_default) && isActive;
      if (existing?.is_default && !isDefault) {
        throw ApiError.unprocessable("Make another option the default for this group first", "DEFAULT_REQUIRED", { isDefault: "Each group needs a default" });
      }
      if (isDefault) await VcPrintOption.update({ is_default: false }, { where: { group_code: data.groupCode }, transaction });
      const values = {
        group_code: data.groupCode,
        code: data.code,
        name: data.name,
        description: data.description,
        price_per_card_paise: data.pricePerCard,
        is_default: isDefault,
        is_active: isActive,
        ...(data.sortOrder !== undefined ? { sort_order: data.sortOrder } : {}),
      };
      const before = existing ? orders.presentOption(existing) : null;
      const option = existing ? await existing.update(values, { transaction }) : await VcPrintOption.create(values, { transaction });
      // A group with options but no default would leave customers without a preselection.
      const defaults = await VcPrintOption.count({ where: { group_code: data.groupCode, is_default: true }, transaction });
      if (!defaults) await option.update({ is_default: true, is_active: true }, { transaction });
      return { option: orders.presentOption(option), before };
    });
  } catch (error) {
    if (error instanceof UniqueConstraintError) throw ApiError.conflict("Another option already uses this code", "DUPLICATE", { code: "Already in use" });
    throw error;
  }
}

async function deleteOption(id) {
  const option = await VcPrintOption.findByPk(id);
  if (!option) throw ApiError.notFound("Printing option not found");
  if (option.is_default) throw ApiError.conflict("Make another option the default before removing this one", "DEFAULT_REQUIRED");
  const before = orders.presentOption(option);
  // Orders keep a copy of the options they were placed with, so removing one is safe.
  await option.destroy();
  return { before };
}

// ---------------------------------------------------------------- settings
function presentSettings(s) {
  return {
    enabled: Boolean(s.enabled),
    allowIndividual: Boolean(s.allow_individual),
    allowCorporate: Boolean(s.allow_corporate),
    minOrderQty: s.min_order_qty,
    minQtyPerCard: s.min_qty_per_card,
    maxQtyPerCard: s.max_qty_per_card,
    maxEmployeesPerOrder: s.max_employees_per_order,
    doubleSidedPerCardPaise: s.double_sided_per_card_paise,
    gstRate: Number(s.gst_rate),
    hsnCode: s.hsn_code,
    productionDays: s.production_days,
    artworkReviewRequired: Boolean(s.artwork_review_required),
    shipping: {
      basePaise: s.shipping.base_paise,
      perBoxPaise: s.shipping.per_box_paise,
      boxSize: s.shipping.box_size,
      freeAbovePaise: s.shipping.free_above_paise,
      gstRate: Number(s.shipping.gst_rate),
    },
  };
}

async function getSettings() {
  return presentSettings(await settingsService.get("visiting_cards"));
}

async function saveSettings(auth, d) {
  if (d.minQtyPerCard > d.maxQtyPerCard) throw ApiError.unprocessable("The per-person minimum is above the maximum", "VALIDATION_FAILED", { minQtyPerCard: "Above the maximum" });
  if (!d.allowIndividual && !d.allowCorporate && d.enabled) throw ApiError.unprocessable("Allow individual or corporate orders, or switch the module off", "VALIDATION_FAILED", { allowIndividual: "Choose at least one" });
  const slabs = await VcPriceSlab.findAll();
  const first = Math.min(...slabs.map((s) => s.min_qty));
  if (slabs.length && first > d.minOrderQty) {
    throw ApiError.unprocessable(`The first price slab starts at ${first} cards. Lower it on the Pricing page before lowering the minimum order.`, "VALIDATION_FAILED", { minOrderQty: `At least ${first}` });
  }
  const before = await getSettings();
  await settingsService.set(
    "visiting_cards",
    {
      enabled: d.enabled,
      allow_individual: d.allowIndividual,
      allow_corporate: d.allowCorporate,
      min_order_qty: d.minOrderQty,
      min_qty_per_card: d.minQtyPerCard,
      max_qty_per_card: d.maxQtyPerCard,
      max_employees_per_order: d.maxEmployeesPerOrder,
      double_sided_per_card_paise: d.doubleSidedPerCard,
      gst_rate: d.gstRate,
      hsn_code: d.hsnCode,
      production_days: d.productionDays,
      artwork_review_required: d.artworkReviewRequired,
      shipping: { base_paise: d.shipping.base, per_box_paise: d.shipping.perBox, box_size: d.shipping.boxSize, free_above_paise: d.shipping.freeAbove, gst_rate: d.shipping.gstRate },
    },
    auth.user.id
  );
  return { before, after: await getSettings() };
}

module.exports = { dashboard, reports, customers, pricingTable, saveSlabs, listOptions, saveOption, deleteOption, getSettings, saveSettings };
