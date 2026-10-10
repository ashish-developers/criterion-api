const { define, T } = require("./define");

const ArtworkAsset = define(
  "ArtworkAsset",
  "artwork_assets",
  {
    id: T.uuidPk,
    owner_user_id: T.uuid,
    company_id: T.uuid,
    brand_kit_id: T.uuid,
    kind: T.str,
    original_name: T.str,
    storage_key: T.str,
    mime_type: T.str,
    size_bytes: T.money,
    width_px: T.int,
    height_px: T.int,
    checksum: T.str,
    scan_status: T.str,
    is_public: T.bool,
  },
  { timestamps: "created", paranoid: true }
);

const Design = define(
  "Design",
  "designs",
  {
    id: T.uuidPk,
    user_id: T.uuid,
    company_id: T.uuid,
    product_id: T.uuid,
    variant_id: T.uuid,
    name: T.str,
    is_brand_template: T.bool,
    current_version_id: T.uuid,
  },
  { paranoid: true }
);

const DesignVersion = define(
  "DesignVersion",
  "design_versions",
  {
    id: T.uuidPk,
    design_id: T.uuid,
    version_no: T.int,
    canvas: T.json,
    asset_ids: T.uuids,
    preview_asset_id: T.uuid,
    method_id: T.int,
    variant_id: T.uuid,
    warnings: T.json,
    created_by: T.uuid,
  },
  { timestamps: "created" }
);

const Cart = define("Cart", "carts", { id: T.uuidPk, user_id: T.uuid, coupon_code: T.str });

const CartItem = define("CartItem", "cart_items", {
  id: T.uuidPk,
  cart_id: T.uuid,
  product_id: T.uuid,
  variant_id: T.uuid,
  method_id: T.int,
  design_version_id: T.uuid,
  quantity: T.int,
  size_breakdown: T.json,
  print_area_count: T.int,
  express: T.bool,
  options: T.json,
});

const Coupon = define("Coupon", "coupons", {
  id: T.uuidPk,
  code: T.str,
  description: T.str,
  discount_type: T.str,
  value: T.decimal,
  min_order_paise: T.money,
  max_discount_paise: T.money,
  applies_to: T.str,
  starts_at: T.time,
  ends_at: T.time,
  usage_limit: T.int,
  per_user_limit: T.int,
  used_count: T.int,
  is_active: T.bool,
});

const CouponRedemption = define(
  "CouponRedemption",
  "coupon_redemptions",
  { id: T.bigPk, coupon_id: T.uuid, user_id: T.uuid, order_id: T.uuid, amount_paise: T.money },
  { timestamps: "created" }
);

const Quote = define("Quote", "quotes", {
  id: T.uuidPk,
  quote_number: T.str,
  requester_user_id: T.uuid,
  company_id: T.uuid,
  status: T.str,
  title: T.str,
  deadline: T.date,
  budget_paise: T.money,
  delivery_locations: T.text,
  delivery_pincode: T.str,
  notes: T.text,
  current_version_id: T.uuid,
  assigned_admin_id: T.uuid,
  order_id: T.uuid,
  is_repeat_of: T.uuid,
  first_response_at: T.time,
  recipients: T.json,
});

const QuoteRequestItem = define(
  "QuoteRequestItem",
  "quote_request_items",
  {
    id: T.uuidPk,
    quote_id: T.uuid,
    product_id: T.uuid,
    variant_id: T.uuid,
    method_id: T.int,
    quantity: T.int,
    size_breakdown: T.json,
    print_area_count: T.int,
    artwork_asset_ids: T.uuids,
    design_version_id: T.uuid,
    notes: T.text,
  },
  { timestamps: false }
);

const QuoteVersion = define(
  "QuoteVersion",
  "quote_versions",
  {
    id: T.uuidPk,
    quote_id: T.uuid,
    version_no: T.int,
    valid_until: T.date,
    production_days: T.int,
    payment_terms: T.str,
    subtotal_paise: T.money,
    setup_fees_paise: T.money,
    packaging_paise: T.money,
    shipping_paise: T.money,
    discount_paise: T.money,
    tax_paise: T.money,
    total_paise: T.money,
    notes: T.text,
    created_by: T.uuid,
    sent_at: T.time,
  },
  { timestamps: "created" }
);

const QuoteItem = define(
  "QuoteItem",
  "quote_items",
  {
    id: T.uuidPk,
    quote_version_id: T.uuid,
    request_item_id: T.uuid,
    product_id: T.uuid,
    variant_id: T.uuid,
    method_id: T.int,
    description: T.str,
    quantity: T.int,
    size_breakdown: T.json,
    unit_price_paise: T.money,
    setup_fee_paise: T.money,
    hsn_code: T.str,
    gst_rate: T.decimal,
    line_total_paise: T.money,
    tax_paise: T.money,
  },
  { timestamps: false }
);

const QuoteMessage = define(
  "QuoteMessage",
  "quote_messages",
  { id: T.bigPk, quote_id: T.uuid, user_id: T.uuid, body: T.text },
  { timestamps: "created" }
);

const Order = define("Order", "orders", {
  id: T.uuidPk,
  order_number: T.str,
  user_id: T.uuid,
  company_id: T.uuid,
  quote_id: T.uuid,
  channel: T.str,
  status: T.str,
  payment_status: T.str,
  payment_terms: T.str,
  approval_status: T.str,
  approved_by: T.uuid,
  approved_at: T.time,
  subtotal_paise: T.money,
  setup_fees_paise: T.money,
  discount_paise: T.money,
  shipping_paise: T.money,
  tax_paise: T.money,
  cgst_paise: T.money,
  sgst_paise: T.money,
  igst_paise: T.money,
  total_paise: T.money,
  amount_paid_paise: T.money,
  amount_refunded_paise: T.money,
  coupon_id: T.uuid,
  coupon_code: T.str,
  shipping_address: T.json,
  billing_address: T.json,
  gstin: T.str,
  po_number: T.str,
  gift_options: T.json,
  deliver_by: T.date,
  estimated_delivery: T.date,
  notes: T.text,
  idempotency_key: T.str,
  reorder_of_order_id: T.uuid,
  cancel_reason: T.text,
  placed_at: T.time,
  cancelled_at: T.time,
  delivered_at: T.time,
  closed_at: T.time,
  is_demo: T.bool,
  recipients: T.json,
});

const OrderItem = define("OrderItem", "order_items", {
  id: T.uuidPk,
  order_id: T.uuid,
  line_no: T.int,
  product_id: T.uuid,
  variant_id: T.uuid,
  method_id: T.int,
  design_version_id: T.uuid,
  product_snapshot: T.json,
  quantity: T.int,
  size_breakdown: T.json,
  print_area_count: T.int,
  express: T.bool,
  unit_price_paise: T.money,
  setup_fee_paise: T.money,
  line_subtotal_paise: T.money,
  discount_paise: T.money,
  taxable_paise: T.money,
  hsn_code: T.str,
  gst_rate: T.decimal,
  tax_paise: T.money,
  line_total_paise: T.money,
  unit_cost_paise: T.money,
  requires_proof: T.bool,
  state: T.str,
  previous_state: T.str,
  fulfilment_source: T.str,
  vendor_id: T.uuid,
  approved_proof_id: T.uuid,
  due_date: T.date,
  reprint_of_item_id: T.uuid,
  delivered_at: T.time,
});

const OrderEvent = define(
  "OrderEvent",
  "order_events",
  {
    id: T.bigPk,
    order_id: T.uuid,
    order_item_id: T.uuid,
    event: T.str,
    from_state: T.str,
    to_state: T.str,
    note: T.text,
    is_customer_visible: T.bool,
    actor_user_id: T.uuid,
  },
  { timestamps: "created" }
);

const Proof = define("Proof", "proofs", {
  id: T.uuidPk,
  order_item_id: T.uuid,
  design_version_id: T.uuid,
  version_no: T.int,
  status: T.str,
  preview_asset_id: T.uuid,
  print_file_asset_id: T.uuid,
  source: T.str,
  notes: T.text,
  required_approvals: T.int,
  is_chargeable: T.bool,
  locked: T.bool,
  sent_at: T.time,
  approved_at: T.time,
  reminder_24_at: T.time,
  reminder_48_at: T.time,
  created_by: T.uuid,
});

const ProofApproval = define(
  "ProofApproval",
  "proof_approvals",
  { id: T.bigPk, proof_id: T.uuid, user_id: T.uuid, decision: T.str, comment: T.text },
  { timestamps: "created" }
);

module.exports = {
  ArtworkAsset,
  Design,
  DesignVersion,
  Cart,
  CartItem,
  Coupon,
  CouponRedemption,
  Quote,
  QuoteRequestItem,
  QuoteVersion,
  QuoteItem,
  QuoteMessage,
  Order,
  OrderItem,
  OrderEvent,
  Proof,
  ProofApproval,
};
