// Order listing filters, grouped by the module each status belongs to. This map is the single
// source of truth: the list endpoints validate against it and the filter-options endpoint
// sends it (with counts) to the UI, so the UI never offers a status that does not exist or
// belongs to another module.
//
//   order       the order's overall status (orders.status, derived from its lines)
//   payment     orders.payment_status (+ "failed": nothing paid and the latest attempt failed)
//   production  order lines in an artwork / production state (an order matches if any live line does)
//   shipping    order lines in a dispatch state (same "any live line" rule)
const { Op, literal } = require("sequelize");
const ApiError = require("../Utils/ApiError");

const MODULES = {
  order: {
    label: "Order",
    column: "status",
    statuses: {
      pending_confirmation: "Pending confirmation",
      awaiting_approval: "Awaiting company approval",
      payment_pending: "Payment pending",
      confirmed: "Confirmed",
      in_progress: "In progress",
      partially_shipped: "Partially shipped",
      shipped: "Shipped",
      delivered: "Delivered",
      completed: "Completed",
      cancelled: "Cancelled",
      refunded: "Refunded",
    },
  },
  payment: {
    label: "Payment",
    column: "payment_status",
    statuses: {
      pending: "Pending",
      partially_paid: "Partially paid",
      paid: "Paid",
      failed: "Failed",
      credit: "Credit terms",
      partially_refunded: "Partially refunded",
      refunded: "Refunded",
    },
  },
  production: {
    label: "Production",
    lines: {
      artwork_pending: { label: "Artwork pending", states: ["artwork_pending", "proof_sent"] },
      artwork_approved: { label: "Artwork approved (ready to assign)", states: ["proof_approved"] },
      assigned: { label: "Assigned to production", states: ["assigned"] },
      in_production: { label: "In production", states: ["in_production"] },
      quality_check: { label: "Quality check", states: ["quality_check", "qc_failed"] },
      on_hold: { label: "On hold", states: ["on_hold"] },
    },
  },
  shipping: {
    label: "Shipping",
    lines: {
      ready_to_dispatch: { label: "Ready to dispatch", states: ["packed"] },
      dispatched: { label: "Dispatched", states: ["dispatched"] },
      returned: { label: "Returned to origin (RTO)", states: ["rto"] },
      delivered: { label: "Delivered", states: ["delivered", "closed"] },
    },
  },
};

// Nothing paid, and the latest payment attempt failed.
const FAILED_PAYMENT_SQL = `("Order"."amount_paid_paise" = 0 AND "Order"."payment_status" IN ('pending','failed') AND (
  "Order"."payment_status" = 'failed' OR
  (SELECT p.status FROM payments p WHERE p.order_id = "Order"."id" ORDER BY p.created_at DESC LIMIT 1) = 'failed'))`;

function statusesOf(module) {
  const m = MODULES[module];
  return m.statuses ? Object.keys(m.statuses) : Object.keys(m.lines);
}

/**
 * Sequelize `where` additions for a module + status filter. A bare `status` (no module) keeps its
 * original meaning: the order status, optionally comma-separated.
 */
function whereFor({ module, status }) {
  if (!status) return {};
  const key = module || "order";
  const m = MODULES[key];
  if (!m) throw ApiError.unprocessable(`Unknown filter module "${module}"`, "INVALID_FILTER");
  const values = status.split(",").filter(Boolean);
  const invalid = values.filter((v) => !statusesOf(key).includes(v));
  if (invalid.length) throw ApiError.unprocessable(`"${invalid.join(", ")}" is not a ${m.label.toLowerCase()} status`, "INVALID_FILTER");

  if (m.column && key === "payment" && values.includes("failed")) {
    const others = values.filter((v) => v !== "failed");
    return { [Op.or]: [literal(FAILED_PAYMENT_SQL), ...(others.length ? [{ payment_status: { [Op.in]: others } }] : [])] };
  }
  if (m.column) return { [m.column]: values.length === 1 ? values[0] : { [Op.in]: values } };
  const states = values.flatMap((v) => m.lines[v].states);
  const list = states.map((s) => `'${s}'`).join(",");
  return { [Op.and]: [literal(`EXISTS (SELECT 1 FROM order_items oi WHERE oi.order_id = "Order"."id" AND oi.state IN (${list}))`)] };
}

/** Every module with its statuses and how many orders (within `baseWhereSql`) match each. */
async function options(sequelize, { whereSql = "TRUE", replacements = {} } = {}) {
  const [[columns], [lines], [failed]] = await Promise.all([
    sequelize.query(
      `SELECT 'order' AS module, status AS value, count(*)::int AS n FROM orders o WHERE ${whereSql} GROUP BY status
       UNION ALL
       SELECT 'payment', payment_status, count(*)::int FROM orders o WHERE ${whereSql} GROUP BY payment_status`,
      { replacements }
    ),
    sequelize.query(
      `SELECT oi.state AS value, count(DISTINCT o.id)::int AS n
         FROM orders o JOIN order_items oi ON oi.order_id = o.id
        WHERE ${whereSql} GROUP BY oi.state`,
      { replacements }
    ),
    sequelize.query(`SELECT count(*)::int AS n FROM orders o WHERE ${whereSql} AND ${FAILED_PAYMENT_SQL.replaceAll('"Order"', "o")}`, { replacements }),
  ]);
  const count = (module, value) => columns.find((r) => r.module === module && r.value === value)?.n || 0;
  // Line buckets can share an order (two lines in different states): count orders per bucket.
  const lineCount = async (states) => {
    const [[row]] = await sequelize.query(
      `SELECT count(DISTINCT o.id)::int AS n FROM orders o JOIN order_items oi ON oi.order_id = o.id WHERE ${whereSql} AND oi.state IN (:states)`,
      { replacements: { ...replacements, states } }
    );
    return row.n;
  };
  const out = [];
  for (const [key, m] of Object.entries(MODULES)) {
    const statuses = [];
    if (m.statuses) {
      for (const [value, label] of Object.entries(m.statuses)) {
        const n = key === "payment" && value === "failed" ? failed[0].n : count(key, value);
        statuses.push({ value, label, count: n });
      }
    } else {
      for (const [value, def] of Object.entries(m.lines)) {
        // Single-state buckets come from the grouped query; multi-state ones are counted directly.
        const n = def.states.length === 1 ? lines.find((r) => r.value === def.states[0])?.n || 0 : await lineCount(def.states);
        statuses.push({ value, label: def.label, count: n });
      }
    }
    out.push({ module: key, label: m.label, statuses });
  }
  return out;
}

module.exports = { MODULES, whereFor, options, statusesOf };
