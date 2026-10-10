const { define, T } = require("./define");

const ProductionJob = define("ProductionJob", "production_jobs", {
  id: T.uuidPk,
  job_number: T.str,
  order_item_id: T.uuid,
  source: T.str,
  vendor_id: T.uuid,
  proof_id: T.uuid,
  method_id: T.int,
  quantity: T.int,
  due_date: T.date,
  agreed_cost_paise: T.money,
  status: T.str,
  rejection_code: T.str,
  rejection_note: T.text,
  is_reprint: T.bool,
  parent_job_id: T.uuid,
  machine: T.str,
  notes: T.text,
  assigned_by: T.uuid,
  assigned_at: T.time,
  accepted_at: T.time,
  started_at: T.time,
  completed_at: T.time,
  dispatched_at: T.time,
});

const JobEvent = define(
  "JobEvent",
  "job_events",
  { id: T.bigPk, job_id: T.uuid, event: T.str, status: T.str, note: T.text, photo_asset_ids: T.uuids, actor_user_id: T.uuid },
  { timestamps: "created" }
);

const QcCheck = define(
  "QcCheck",
  "qc_checks",
  {
    id: T.bigPk,
    job_id: T.uuid,
    result: T.str,
    checklist: T.json,
    defect_qty: T.int,
    decision: T.str,
    notes: T.text,
    photo_asset_ids: T.uuids,
    checked_by: T.uuid,
  },
  { timestamps: "created" }
);

const Shipment = define("Shipment", "shipments", {
  id: T.uuidPk,
  shipment_number: T.str,
  order_id: T.uuid,
  parent_shipment_id: T.uuid,
  vendor_id: T.uuid,
  shipped_by: T.str,
  carrier: T.str,
  tracking_number: T.str,
  tracking_url: T.text,
  status: T.str,
  address: T.json,
  weight_grams: T.int,
  dispatched_at: T.time,
  delivered_at: T.time,
  created_by: T.uuid,
  recipient_ref: T.str,
});

const ShipmentItem = define(
  "ShipmentItem",
  "shipment_items",
  {
    shipment_id: { type: T.uuid, primaryKey: true },
    order_item_id: { type: T.uuid, primaryKey: true },
    quantity: T.int,
  },
  { timestamps: false }
);

const TrackingEvent = define(
  "TrackingEvent",
  "tracking_events",
  { id: T.bigPk, shipment_id: T.uuid, status: T.str, location: T.str, description: T.text, occurred_at: T.time },
  { timestamps: "created" }
);

const Payment = define("Payment", "payments", {
  id: T.uuidPk,
  order_id: T.uuid,
  provider: T.str,
  purpose: T.str,
  provider_order_id: T.str,
  provider_payment_id: T.str,
  amount_paise: T.money,
  currency: T.str,
  status: T.str,
  method: T.str,
  signature_verified: T.bool,
  failure_reason: T.text,
  raw: T.json,
  captured_at: T.time,
  created_by: T.uuid,
});

const PaymentWebhookEvent = define(
  "PaymentWebhookEvent",
  "payment_webhook_events",
  { id: T.bigPk, provider: T.str, event_id: T.str, event_type: T.str, payload: T.json, processed_at: T.time },
  { timestamps: "created" }
);

const Refund = define("Refund", "refunds", {
  id: T.uuidPk,
  order_id: T.uuid,
  payment_id: T.uuid,
  order_item_id: T.uuid,
  ticket_id: T.uuid,
  amount_paise: T.money,
  reason: T.text,
  status: T.str,
  provider_refund_id: T.str,
  requested_by: T.uuid,
  approved_by: T.uuid,
  processed_at: T.time,
});

const Invoice = define(
  "Invoice",
  "invoices",
  {
    id: T.uuidPk,
    invoice_number: T.str,
    order_id: T.uuid,
    seller: T.json,
    buyer: T.json,
    place_of_supply: T.str,
    is_interstate: T.bool,
    lines: T.json,
    taxable_paise: T.money,
    cgst_paise: T.money,
    sgst_paise: T.money,
    igst_paise: T.money,
    total_paise: T.money,
    po_number: T.str,
    irn: T.str,
    issued_at: T.time,
    due_date: T.date,
  },
  { timestamps: "created" }
);

const Settlement = define("Settlement", "settlements", {
  id: T.uuidPk,
  settlement_number: T.str,
  vendor_id: T.uuid,
  period_start: T.date,
  period_end: T.date,
  gross_paise: T.money,
  commission_paise: T.money,
  fees_paise: T.money,
  adjustments_paise: T.money,
  tcs_paise: T.money,
  tds_paise: T.money,
  payout_paise: T.money,
  status: T.str,
  payout_reference: T.str,
  paid_at: T.time,
  created_by: T.uuid,
});

const Commission = define(
  "Commission",
  "commissions",
  {
    id: T.bigPk,
    order_item_id: T.uuid,
    vendor_id: T.uuid,
    model: T.str,
    item_value_paise: T.money,
    commission_pct: T.decimal,
    commission_paise: T.money,
    vendor_earning_paise: T.money,
    adjustment_paise: T.money,
    settlement_id: T.uuid,
    eligible_at: T.time,
  },
  { timestamps: "created" }
);

const SettlementLine = define(
  "SettlementLine",
  "settlement_lines",
  {
    id: T.bigPk,
    settlement_id: T.uuid,
    order_item_id: T.uuid,
    item_value_paise: T.money,
    commission_paise: T.money,
    adjustment_paise: T.money,
    net_paise: T.money,
  },
  { timestamps: false }
);

const Ticket = define("Ticket", "tickets", {
  id: T.uuidPk,
  ticket_number: T.str,
  user_id: T.uuid,
  order_id: T.uuid,
  order_item_id: T.uuid,
  type: T.str,
  subject: T.str,
  status: T.str,
  priority: T.str,
  decision: T.str,
  liability: T.str,
  resolution_note: T.text,
  reprint_order_item_id: T.uuid,
  assigned_to: T.uuid,
  resolved_at: T.time,
});

const TicketMessage = define(
  "TicketMessage",
  "ticket_messages",
  { id: T.bigPk, ticket_id: T.uuid, user_id: T.uuid, body: T.text, attachment_asset_ids: T.uuids, is_internal: T.bool },
  { timestamps: "created" }
);

const Notification = define(
  "Notification",
  "notifications",
  {
    id: T.bigPk,
    user_id: T.uuid,
    type: T.str,
    title: T.str,
    body: T.text,
    link: T.str,
    channels: T.strings,
    email_status: T.str,
    read_at: T.time,
  },
  { timestamps: "created" }
);

const Review = define("Review", "reviews", {
  id: T.uuidPk,
  product_id: T.uuid,
  user_id: T.uuid,
  order_item_id: T.uuid,
  rating: T.int,
  title: T.str,
  body: T.text,
  photo_asset_ids: T.uuids,
  status: T.str,
});

const Setting = define(
  "Setting",
  "settings",
  { key: { type: T.str, primaryKey: true }, value: T.json, description: T.text, updated_by: T.uuid, updated_at: T.time },
  { timestamps: false }
);

const CmsPage = define("CmsPage", "cms_pages", {
  id: T.uuidPk,
  slug: T.str,
  type: T.str,
  title: T.str,
  body: T.text,
  sort_order: T.int,
  is_published: T.bool,
  updated_by: T.uuid,
});

const AuditLog = define(
  "AuditLog",
  "audit_logs",
  {
    id: T.bigPk,
    actor_user_id: T.uuid,
    action: T.str,
    entity_type: T.str,
    entity_id: T.str,
    before: T.json,
    after: T.json,
    ip: T.str,
    user_agent: T.text,
  },
  { timestamps: "created" }
);

module.exports = {
  ProductionJob,
  JobEvent,
  QcCheck,
  Shipment,
  ShipmentItem,
  TrackingEvent,
  Payment,
  PaymentWebhookEvent,
  Refund,
  Invoice,
  Settlement,
  Commission,
  SettlementLine,
  Ticket,
  TicketMessage,
  Notification,
  Review,
  Setting,
  CmsPage,
  AuditLog,
};
