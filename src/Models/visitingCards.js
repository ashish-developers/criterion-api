const { define, T } = require("./define");

const VcTemplateCategory = define("VcTemplateCategory", "vc_template_categories", {
  id: T.intPk,
  name: T.str,
  slug: T.str,
  description: T.str,
  icon: T.str,
  sort_order: T.int,
  is_active: T.bool,
});

const VcTemplate = define(
  "VcTemplate",
  "vc_templates",
  {
    id: T.uuidPk,
    code: T.str,
    category_id: T.int,
    name: T.str,
    slug: T.str,
    description: T.str,
    orientation: T.str,
    width_mm: T.decimal,
    height_mm: T.decimal,
    bleed_mm: T.decimal,
    safe_margin_mm: T.decimal,
    is_double_sided: T.bool,
    has_qr: T.bool,
    tags: T.strings,
    design: T.json,
    status: T.str,
    is_featured: T.bool,
    sort_order: T.int,
    usage_count: T.int,
    created_by: T.uuid,
    updated_by: T.uuid,
    published_at: T.time,
  },
  { paranoid: true }
);

const VcDesign = define(
  "VcDesign",
  "vc_designs",
  {
    id: T.uuidPk,
    user_id: T.uuid,
    company_id: T.uuid,
    customer_type: T.str,
    template_id: T.uuid,
    name: T.str,
    orientation: T.str,
    width_mm: T.decimal,
    height_mm: T.decimal,
    design: T.json,
    template_design: T.json,
    fields: T.json,
    employees: T.json,
    status: T.str,
    approved_at: T.time,
    last_ordered_at: T.time,
  },
  { paranoid: true }
);

const VcPriceSlab = define("VcPriceSlab", "vc_price_slabs", {
  id: T.intPk,
  min_qty: T.int,
  max_qty: T.int,
  unit_price_paise: T.int,
  label: T.str,
});

const VcPrintOption = define("VcPrintOption", "vc_print_options", {
  id: T.intPk,
  group_code: T.str,
  code: T.str,
  name: T.str,
  description: T.str,
  price_per_card_paise: T.int,
  is_default: T.bool,
  is_active: T.bool,
  sort_order: T.int,
});

const VcOrder = define("VcOrder", "vc_orders", {
  id: T.uuidPk,
  order_number: T.str,
  user_id: T.uuid,
  company_id: T.uuid,
  customer_type: T.str,
  design_id: T.uuid,
  template_id: T.uuid,
  template_snapshot: T.json,
  design_snapshot: T.json,
  fields_snapshot: T.json,
  is_double_sided: T.bool,
  card_count: T.int,
  total_quantity: T.int,
  print_options: T.json,
  pricing: T.json,
  unit_price_paise: T.int,
  subtotal_paise: T.money,
  shipping_paise: T.money,
  taxable_paise: T.money,
  cgst_paise: T.money,
  sgst_paise: T.money,
  igst_paise: T.money,
  tax_paise: T.money,
  total_paise: T.money,
  amount_paid_paise: T.money,
  gst_rate: T.decimal,
  hsn_code: T.str,
  is_interstate: T.bool,
  status: T.str,
  payment_status: T.str,
  artwork_status: T.str,
  artwork_note: T.str,
  artwork_reviewed_by: T.uuid,
  artwork_reviewed_at: T.time,
  contact: T.json,
  shipping_address: T.json,
  billing_address: T.json,
  gstin: T.str,
  customer_note: T.str,
  estimated_dispatch: T.date,
  estimated_delivery: T.date,
  courier: T.str,
  tracking_number: T.str,
  tracking_url: T.str,
  idempotency_key: T.str,
  placed_at: T.time,
  paid_at: T.time,
  approved_at: T.time,
  production_started_at: T.time,
  dispatched_at: T.time,
  delivered_at: T.time,
  cancelled_at: T.time,
  cancel_reason: T.str,
  is_demo: T.bool,
});

const VcOrderCard = define("VcOrderCard", "vc_order_cards", {
  id: T.uuidPk,
  order_id: T.uuid,
  line_no: T.int,
  fields: T.json,
  quantity: T.int,
});

const VcOrderEvent = define(
  "VcOrderEvent",
  "vc_order_events",
  {
    id: T.bigPk,
    order_id: T.uuid,
    actor_user_id: T.uuid,
    action: T.str,
    from_status: T.str,
    to_status: T.str,
    note: T.str,
  },
  { timestamps: "created" }
);

const VcPayment = define("VcPayment", "vc_payments", {
  id: T.uuidPk,
  order_id: T.uuid,
  receipt_number: T.str,
  provider: T.str,
  provider_order_id: T.str,
  provider_payment_id: T.str,
  provider_refund_id: T.str,
  amount_paise: T.money,
  currency: T.str,
  status: T.str,
  method: T.str,
  signature_verified: T.bool,
  failure_reason: T.str,
  raw: T.json,
  captured_at: T.time,
  refunded_at: T.time,
  created_by: T.uuid,
});

const VcInvoice = define(
  "VcInvoice",
  "vc_invoices",
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
    issued_at: T.time,
  },
  { timestamps: "created" }
);

module.exports = { VcTemplateCategory, VcTemplate, VcDesign, VcPriceSlab, VcPrintOption, VcOrder, VcOrderCard, VcOrderEvent, VcPayment, VcInvoice };
