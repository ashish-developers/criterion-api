const { Setting } = require("../Models");

// Defaults apply until an admin saves a value. Tax rates for TCS/TDS are placeholders:
// confirm current rates with a tax adviser before go-live (Section 8.5).
const DEFAULTS = {
  seller: {
    description: "Seller details printed on GST invoices",
    value: {
      legal_name: "Branding Gifts Private Limited",
      gstin: "27AAACB1234C1Z5",
      pan: "AAACB1234C",
      state: "Maharashtra",
      state_code: "27",
      address: "Unit 4, Andheri Industrial Estate, Mumbai 400053",
      email: "accounts@example.com",
      phone: "+91 22 4000 0000",
    },
  },
  shipping: {
    description: "Rule-based shipping estimator used until a shipping aggregator is connected",
    value: {
      origin_pincode: "400053",
      base_paise: 6000,
      per_500g_paise: 2500,
      free_above_paise: 99900,
      gst_rate: 18,
      transit_days: { local: 1, regional: 3, national: 5, remote: 8 },
      remote_prefixes: ["78", "79", "18", "19", "74", "744"],
      unserviceable_prefixes: [],
    },
  },
  proofs: {
    description: "Proof approval policy",
    value: { free_revisions: 2, revision_fee_paise: 25000, reminder_hours: [24, 48] },
  },
  orders: {
    description: "Order policies",
    value: { complaint_window_days: 7, b2b_advance_pct: 50, quote_validity_days: 15 },
  },
  marketplace: {
    description: "Marketplace settlement deductions (percent). Confirm with a tax adviser.",
    value: { tcs_pct: 0.5, tds_pct: 0.1, payment_gateway_fee_pct: 2, settlement_cycle_days: 7 },
  },
  routing: {
    description: "Fulfilment routing scorecard weights (Section 8.2)",
    value: { cost: 35, lead_time: 25, quality: 25, distance: 10, load: 5, min_quality_score: 3.5 },
  },
  notifications: {
    description: "Notification channels",
    value: { email: true, sms: false },
  },
  blog: {
    description: "Blog workflow: when approval is required, posts by users without blog.approve must be approved before they can be published or scheduled",
    value: { approval_required: true },
  },
};

let cache = null;

async function loadAll() {
  if (cache) return cache;
  const rows = await Setting.findAll();
  const values = {};
  for (const [key, def] of Object.entries(DEFAULTS)) values[key] = structuredClone(def.value);
  for (const row of rows) values[row.key] = { ...(values[row.key] || {}), ...row.value };
  cache = values;
  return values;
}

async function get(key) {
  const all = await loadAll();
  return all[key];
}

async function set(key, value, userId) {
  if (!DEFAULTS[key]) throw new Error(`Unknown setting ${key}`);
  await Setting.upsert({ key, value, description: DEFAULTS[key].description, updated_by: userId, updated_at: new Date() });
  cache = null;
  return get(key);
}

function describe() {
  return Object.fromEntries(Object.entries(DEFAULTS).map(([k, v]) => [k, v.description]));
}

function clearCache() {
  cache = null;
}

module.exports = { get, set, loadAll, describe, clearCache, DEFAULTS };
