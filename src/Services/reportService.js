// Dashboard metrics and reports (Section 6.7 FR-AD-06, Section 12.3 KPIs).
// Every figure is computed from the database; nothing is hard-coded.
const { sequelize } = require("../Models");

const q = async (sql, replacements = {}) => (await sequelize.query(sql, { replacements }))[0];
const n = (v) => (v === null || v === undefined ? 0 : Number(v));

function range({ from, to }) {
  const end = to ? new Date(`${to}T23:59:59Z`) : new Date();
  const start = from ? new Date(`${from}T00:00:00Z`) : new Date(end.getTime() - 29 * 86400 * 1000);
  return { from: start, to: end };
}

async function dashboard(auth, query = {}) {
  const r = range(query);
  const pricing = auth.permissions.has("payments.view") || auth.permissions.has("reports.view");
  const [orders] = await q(
    `SELECT count(*)::int AS orders,
            COALESCE(sum(total_paise) FILTER (WHERE status NOT IN ('cancelled','refunded')),0)::bigint AS sales,
            COALESCE(sum(amount_paid_paise),0)::bigint AS collected,
            count(*) FILTER (WHERE payment_status IN ('pending','partially_paid') AND status NOT IN ('cancelled','refunded'))::int AS pending_payments,
            COALESCE(sum(total_paise - amount_paid_paise) FILTER (WHERE payment_status IN ('pending','partially_paid','credit') AND status NOT IN ('cancelled','refunded')),0)::bigint AS receivable,
            count(*) FILTER (WHERE channel = 'b2b')::int AS b2b_orders,
            count(*) FILTER (WHERE status = 'awaiting_approval')::int AS awaiting_approval
       FROM orders WHERE placed_at BETWEEN :from AND :to`,
    r
  );
  const [refunds] = await q(
    `SELECT count(*) FILTER (WHERE status IN ('requested','approved'))::int AS pending, COALESCE(sum(amount_paise) FILTER (WHERE status = 'processed'),0)::bigint AS refunded FROM refunds`
  );
  const [people] = await q(
    `SELECT count(*) FILTER (WHERE account_type = 'individual' AND created_at BETWEEN :from AND :to)::int AS new_customers,
            (SELECT count(*)::int FROM companies WHERE created_at BETWEEN :from AND :to) AS new_companies,
            (SELECT count(*)::int FROM companies) AS companies
       FROM users WHERE deleted_at IS NULL`,
    r
  );
  const [quotes] = await q(
    `SELECT count(*) FILTER (WHERE status IN ('requested','under_review','revision_requested'))::int AS pending,
            count(*) FILTER (WHERE status = 'sent')::int AS awaiting_customer,
            count(*) FILTER (WHERE status IN ('accepted','converted'))::int AS won,
            count(*) FILTER (WHERE current_version_id IS NOT NULL)::int AS sent_ever
       FROM quotes`
  );
  const [vendors] = await q(
    `SELECT count(*) FILTER (WHERE status = 'approved')::int AS active, count(*) FILTER (WHERE status IN ('applied','under_review'))::int AS pending FROM vendors`
  );
  const [production] = await q(
    `SELECT count(*) FILTER (WHERE status NOT IN ('dispatched','delivered','cancelled','rejected'))::int AS open_jobs,
            count(*) FILTER (WHERE status NOT IN ('dispatched','delivered','cancelled','rejected') AND due_date < current_date)::int AS delayed,
            count(*) FILTER (WHERE status = 'assigned' AND assigned_at < now() - interval '4 hours')::int AS unaccepted
       FROM production_jobs`
  );
  const [lines] = await q(
    `SELECT count(*) FILTER (WHERE state = 'artwork_pending')::int AS artwork_pending,
            count(*) FILTER (WHERE state = 'proof_sent')::int AS proofs_waiting,
            count(*) FILTER (WHERE state = 'proof_approved')::int AS ready_to_assign
       FROM order_items`
  );
  const [stock] = await q(
    `SELECT count(*)::int AS low FROM product_variants pv JOIN products p ON p.id = pv.product_id
      WHERE pv.track_inventory AND pv.is_active AND p.deleted_at IS NULL AND pv.stock_qty <= pv.low_stock_threshold`
  );
  const [tickets] = await q(`SELECT count(*) FILTER (WHERE status IN ('open','in_progress'))::int AS open FROM tickets`);
  const salesByDay = await q(
    `SELECT to_char(d::date, 'YYYY-MM-DD') AS day,
            COALESCE(sum(o.total_paise) FILTER (WHERE o.status NOT IN ('cancelled','refunded')),0)::bigint AS sales,
            count(o.id)::int AS orders
       FROM generate_series(:from::date, :to::date, interval '1 day') d
       LEFT JOIN orders o ON o.placed_at::date = d::date
      GROUP BY 1 ORDER BY 1`,
    r
  );
  const recentOrders = await q(
    `SELECT o.id, o.order_number, o.status, o.payment_status, o.total_paise, o.placed_at, o.channel, u.name AS customer
       FROM orders o JOIN users u ON u.id = o.user_id ORDER BY o.placed_at DESC LIMIT 8`
  );
  const topProducts = await q(
    `SELECT oi.product_id, min(oi.product_snapshot->>'name') AS name, min(oi.product_snapshot->>'image') AS image,
            sum(oi.quantity)::int AS units, sum(oi.taxable_paise)::bigint AS revenue
       FROM order_items oi JOIN orders o ON o.id = oi.order_id
      WHERE o.placed_at BETWEEN :from AND :to AND oi.state NOT IN ('cancelled','refunded') AND oi.reprint_of_item_id IS NULL
      GROUP BY oi.product_id ORDER BY units DESC LIMIT 5`,
    r
  );
  const money = (v) => (pricing ? n(v) : null);
  return {
    range: { from: r.from, to: r.to },
    orders: {
      total: orders.orders,
      salesPaise: money(orders.sales),
      collectedPaise: money(orders.collected),
      pendingPayments: orders.pending_payments,
      receivablePaise: money(orders.receivable),
      b2b: orders.b2b_orders,
      awaitingApproval: orders.awaiting_approval,
    },
    refunds: { pending: refunds.pending, refundedPaise: money(refunds.refunded) },
    customers: { newIndividuals: people.new_customers, newCompanies: people.new_companies, companies: people.companies },
    quotes: { pending: quotes.pending, awaitingCustomer: quotes.awaiting_customer, won: quotes.won, conversionPct: quotes.sent_ever ? Math.round((quotes.won / quotes.sent_ever) * 1000) / 10 : null },
    vendors: { active: vendors.active, pendingApproval: vendors.pending },
    production: { openJobs: production.open_jobs, delayed: production.delayed, unaccepted: production.unaccepted, ...lines },
    inventory: { lowStock: stock.low },
    support: { openTickets: tickets.open },
    salesByDay: salesByDay.map((d) => ({ day: d.day, salesPaise: money(d.sales), orders: d.orders })),
    recentOrders: recentOrders.map((o) => ({ ...o, total_paise: money(o.total_paise) })),
    topProducts: topProducts.map((p) => ({ ...p, revenue: money(p.revenue) })),
  };
}

async function sales(query) {
  const r = range(query);
  return q(
    `SELECT to_char(date_trunc('day', o.placed_at), 'YYYY-MM-DD') AS day, o.channel,
            count(*)::int AS orders, sum(o.subtotal_paise)::bigint AS subtotal_paise, sum(o.discount_paise)::bigint AS discount_paise,
            sum(o.shipping_paise)::bigint AS shipping_paise, sum(o.tax_paise)::bigint AS tax_paise, sum(o.total_paise)::bigint AS total_paise
       FROM orders o WHERE o.placed_at BETWEEN :from AND :to AND o.status NOT IN ('cancelled','refunded')
      GROUP BY 1, 2 ORDER BY 1, 2`,
    r
  );
}

async function margin(query) {
  const r = range(query);
  return q(
    `SELECT c.name AS category, COALESCE(oi.fulfilment_source, 'unassigned') AS source, o.channel,
            sum(oi.quantity)::int AS units, sum(oi.taxable_paise)::bigint AS revenue_paise,
            sum(oi.unit_cost_paise * oi.quantity)::bigint AS cost_paise,
            sum(oi.taxable_paise - oi.unit_cost_paise * oi.quantity)::bigint AS margin_paise,
            CASE WHEN sum(oi.taxable_paise) > 0 THEN round(100.0 * sum(oi.taxable_paise - oi.unit_cost_paise * oi.quantity) / sum(oi.taxable_paise), 1) END AS margin_pct
       FROM order_items oi JOIN orders o ON o.id = oi.order_id JOIN products p ON p.id = oi.product_id
       JOIN categories c ON c.id = p.category_id
      WHERE o.placed_at BETWEEN :from AND :to AND oi.state NOT IN ('cancelled','refunded')
      GROUP BY 1, 2, 3 ORDER BY revenue_paise DESC`,
    r
  );
}

async function vendorPerformance() {
  return q(
    `SELECT v.id, v.business_name, v.status, v.quality_score, v.commission_pct,
            count(j.id)::int AS jobs,
            count(j.id) FILTER (WHERE j.status = 'rejected')::int AS rejected,
            round(avg(EXTRACT(EPOCH FROM (j.accepted_at - j.assigned_at)) / 3600)::numeric, 1) AS avg_accept_hours,
            count(j.id) FILTER (WHERE j.dispatched_at IS NOT NULL)::int AS dispatched,
            CASE WHEN count(j.id) FILTER (WHERE j.dispatched_at IS NOT NULL) > 0
                 THEN round(100.0 * count(j.id) FILTER (WHERE j.dispatched_at::date <= j.due_date) / count(j.id) FILTER (WHERE j.dispatched_at IS NOT NULL), 1) END AS on_time_pct,
            COALESCE((SELECT sum(q.defect_qty) FROM qc_checks q JOIN production_jobs jj ON jj.id = q.job_id WHERE jj.vendor_id = v.id), 0)::int AS defects
       FROM vendors v LEFT JOIN production_jobs j ON j.vendor_id = v.id
      GROUP BY v.id ORDER BY jobs DESC, v.business_name`
  );
}

async function kpis(query) {
  const r = range(query);
  const aov = await q(
    `SELECT channel, count(*)::int AS orders, COALESCE(round(avg(total_paise)),0)::bigint AS aov_paise
       FROM orders WHERE placed_at BETWEEN :from AND :to AND status NOT IN ('cancelled','refunded') GROUP BY channel`,
    r
  );
  const [delivery] = await q(
    `SELECT count(*) FILTER (WHERE delivered_at IS NOT NULL)::int AS delivered,
            count(*) FILTER (WHERE delivered_at IS NOT NULL AND (deliver_by IS NULL OR delivered_at::date <= COALESCE(deliver_by, estimated_delivery)))::int AS on_time
       FROM orders WHERE placed_at BETWEEN :from AND :to`,
    r
  );
  const [lines] = await q(
    `SELECT count(*) FILTER (WHERE reprint_of_item_id IS NULL)::int AS lines, count(*) FILTER (WHERE reprint_of_item_id IS NOT NULL)::int AS reprints
       FROM order_items oi JOIN orders o ON o.id = oi.order_id WHERE o.placed_at BETWEEN :from AND :to`,
    r
  );
  const [money] = await q(
    `SELECT COALESCE(sum(total_paise),0)::bigint AS revenue, COALESCE(sum(amount_refunded_paise),0)::bigint AS refunded, count(*)::int AS orders
       FROM orders WHERE placed_at BETWEEN :from AND :to`,
    r
  );
  const [complaints] = await q(`SELECT count(*)::int AS n FROM tickets WHERE type = 'complaint' AND created_at BETWEEN :from AND :to`, r);
  const [quotes] = await q(
    `SELECT count(*) FILTER (WHERE current_version_id IS NOT NULL)::int AS sent, count(*) FILTER (WHERE status IN ('accepted','converted'))::int AS won FROM quotes WHERE created_at BETWEEN :from AND :to`,
    r
  );
  const [proofTurnaround] = await q(
    `SELECT round(avg(EXTRACT(EPOCH FROM (p.sent_at - pay.captured_at)) / 3600)::numeric, 1) AS hours
       FROM proofs p JOIN order_items oi ON oi.id = p.order_item_id
       JOIN LATERAL (SELECT min(captured_at) AS captured_at FROM payments WHERE order_id = oi.order_id AND status IN ('captured','partially_refunded','refunded')) pay ON true
      WHERE p.version_no = 1 AND p.sent_at BETWEEN :from AND :to AND pay.captured_at IS NOT NULL`,
    r
  );
  const [repeat] = await q(
    `SELECT count(*) FILTER (WHERE n >= 2)::int AS repeaters, count(*)::int AS buyers FROM (
       SELECT COALESCE(company_id::text, user_id::text) AS buyer, count(*) AS n FROM orders
        WHERE placed_at > now() - interval '12 months' AND status NOT IN ('cancelled','refunded') GROUP BY 1) t`
  );
  const [margin] = await q(
    `SELECT COALESCE(sum(oi.taxable_paise),0)::bigint AS revenue, COALESCE(sum(oi.unit_cost_paise * oi.quantity),0)::bigint AS cost
       FROM order_items oi JOIN orders o ON o.id = oi.order_id WHERE o.placed_at BETWEEN :from AND :to AND oi.state NOT IN ('cancelled','refunded')`,
    r
  );
  const vendorsPerf = await vendorPerformance();
  const pct = (a, b) => (b ? Math.round((a / b) * 1000) / 10 : null);
  return [
    { kpi: "Quote-to-order conversion", value: pct(quotes.won, quotes.sent), unit: "%", target: "≥ 25%" },
    { kpi: "Average order value (B2C)", value: n(aov.find((a) => a.channel === "b2c")?.aov_paise) / 100, unit: "₹", target: "≥ ₹900" },
    { kpi: "Average order value (B2B)", value: n(aov.find((a) => a.channel === "b2b")?.aov_paise) / 100, unit: "₹", target: "≥ ₹40,000" },
    { kpi: "Gross margin", value: pct(n(margin.revenue) - n(margin.cost), n(margin.revenue)), unit: "%", target: "≥ 40%" },
    { kpi: "On-time delivery", value: pct(delivery.on_time, delivery.delivered), unit: "%", target: "≥ 92%" },
    { kpi: "Proof turnaround (paid → proof sent)", value: proofTurnaround.hours === null ? null : Number(proofTurnaround.hours), unit: "hours", target: "≤ 12 business hours" },
    { kpi: "Defect / reprint rate", value: pct(lines.reprints, lines.lines), unit: "%", target: "≤ 2%" },
    { kpi: "Return / refund rate", value: pct(n(money.refunded), n(money.revenue)), unit: "%", target: "≤ 3%" },
    { kpi: "Complaint rate", value: pct(complaints.n, money.orders), unit: "%", target: "≤ 4%" },
    { kpi: "Repeat purchase rate (12 months)", value: pct(repeat.repeaters, repeat.buyers), unit: "%", target: "B2C ≥ 20%, B2B ≥ 40%" },
    {
      kpi: "Vendor acceptance time (avg)",
      value: (() => {
        const v = vendorsPerf.filter((x) => x.avg_accept_hours !== null);
        return v.length ? Math.round((v.reduce((s, x) => s + Number(x.avg_accept_hours), 0) / v.length) * 10) / 10 : null;
      })(),
      unit: "hours",
      target: "≤ 2 hours",
    },
    { kpi: "Website conversion rate", value: null, unit: "%", target: "≥ 1.5%", note: "Needs web analytics (sessions are not tracked by the API)" },
  ];
}

async function inventory() {
  return q(
    `SELECT pv.id, pv.sku, p.name AS product, pv.attributes, pv.stock_qty, pv.low_stock_threshold,
            (pv.stock_qty <= pv.low_stock_threshold) AS is_low, p.id AS product_id
       FROM product_variants pv JOIN products p ON p.id = pv.product_id
      WHERE pv.track_inventory AND pv.is_active AND p.deleted_at IS NULL
      ORDER BY (pv.stock_qty <= pv.low_stock_threshold) DESC, pv.stock_qty ASC, p.name`
  );
}

function toCsv(rows) {
  if (!rows.length) return "";
  const headers = Object.keys(rows[0]);
  const esc = (v) => {
    if (v === null || v === undefined) return "";
    const s = typeof v === "object" ? JSON.stringify(v) : String(v);
    // Neutralise spreadsheet formula injection.
    const safe = /^[=+\-@\t\r]/.test(s) ? `'${s}` : s;
    return /[",\n]/.test(safe) ? `"${safe.replace(/"/g, '""')}"` : safe;
  };
  return [headers.join(","), ...rows.map((r) => headers.map((h) => esc(r[h])).join(","))].join("\n");
}

module.exports = { dashboard, sales, margin, vendorPerformance, kpis, inventory, toCsv };
