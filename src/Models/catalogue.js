const { define, T } = require("./define");

const Company = define("Company", "companies", {
  id: T.uuidPk,
  name: T.str,
  legal_name: T.str,
  gstin: T.str,
  pan: T.str,
  industry: T.str,
  company_size: T.str,
  website: T.str,
  billing_email: T.str,
  billing_phone: T.str,
  billing_address: T.json,
  credit_limit_paise: T.money,
  approval_limit_paise: T.money,
  payment_terms: T.str,
  credit_approved: T.bool,
  status: T.str,
  is_key_account: T.bool,
  preferred_vendor_id: T.uuid,
  is_demo: T.bool,
});

const CompanyMember = define(
  "CompanyMember",
  "company_members",
  { id: T.intPk, company_id: T.uuid, user_id: T.uuid, member_role: T.str, status: T.str },
  { timestamps: "created" }
);

const Address = define(
  "Address",
  "addresses",
  {
    id: T.uuidPk,
    user_id: T.uuid,
    company_id: T.uuid,
    label: T.str,
    type: T.str,
    contact_name: T.str,
    phone: T.str,
    line1: T.str,
    line2: T.str,
    city: T.str,
    state: T.str,
    pincode: T.str,
    country: T.str,
    is_default: T.bool,
  },
  { paranoid: true }
);

const BrandKit = define("BrandKit", "brand_kits", {
  id: T.uuidPk,
  company_id: T.uuid,
  name: T.str,
  colors: T.json,
  fonts: T.json,
  guidelines: T.text,
});

const DecorationMethod = define("DecorationMethod", "decoration_methods", {
  id: T.intPk,
  code: T.str,
  name: T.str,
  description: T.text,
  default_cost_paise: T.money,
  default_setup_paise: T.money,
  default_moq: T.int,
  in_house: T.bool,
  is_active: T.bool,
});

const Vendor = define(
  "Vendor",
  "vendors",
  {
    id: T.uuidPk,
    owner_user_id: T.uuid,
    business_name: T.str,
    legal_name: T.str,
    vendor_type: T.str,
    gstin: T.str,
    pan: T.str,
    bank_account_name: T.str,
    bank_account_last4: T.str,
    bank_account_number_enc: T.text,
    bank_ifsc: T.str,
    contact_email: T.str,
    contact_phone: T.str,
    address: T.json,
    pincode: T.str,
    service_pincode_prefixes: T.strings,
    machines: T.text,
    daily_capacity: T.int,
    status: T.str,
    commission_pct: T.decimal,
    quality_score: T.decimal,
    rejection_reason: T.text,
    approved_at: T.time,
    approved_by: T.uuid,
    is_demo: T.bool,
  },
  { defaultScope: { attributes: { exclude: ["bank_account_number_enc"] } } }
);

const VendorUser = define(
  "VendorUser",
  "vendor_users",
  { id: T.intPk, vendor_id: T.uuid, user_id: T.uuid, member_role: T.str },
  { timestamps: "created" }
);

const VendorCapability = define(
  "VendorCapability",
  "vendor_capabilities",
  {
    id: T.intPk,
    vendor_id: T.uuid,
    method_id: T.int,
    min_qty: T.int,
    max_qty: T.int,
    daily_capacity: T.int,
    lead_time_days: T.int,
    cost_per_unit_paise: T.money,
    quality_score: T.decimal,
    is_active: T.bool,
  },
  { timestamps: "created" }
);

const VendorHoliday = define(
  "VendorHoliday",
  "vendor_holidays",
  { id: T.intPk, vendor_id: T.uuid, holiday: T.date, note: T.str },
  { timestamps: false }
);

const Category = define("Category", "categories", {
  id: T.uuidPk,
  parent_id: T.uuid,
  name: T.str,
  slug: T.str,
  description: T.text,
  image: T.text,
  default_lead_time_days: T.int,
  sort_order: T.int,
  is_active: T.bool,
  is_demo: T.bool,
});

const Product = define(
  "Product",
  "products",
  {
    id: T.uuidPk,
    category_id: T.uuid,
    vendor_id: T.uuid,
    source_type: T.str,
    name: T.str,
    slug: T.str,
    short_description: T.str,
    description: T.text,
    images: T.json,
    base_cost_paise: T.money,
    packaging_cost_paise: T.money,
    express_uplift_pct: T.decimal,
    hsn_code: T.str,
    gst_rate: T.decimal,
    moq: T.int,
    max_instant_qty: T.int,
    lead_time_days: T.int,
    weight_grams: T.int,
    dimensions: T.json,
    specifications: T.json,
    care_instructions: T.text,
    occasions: T.strings,
    tags: T.strings,
    is_customisable: T.bool,
    supports_live_preview: T.bool,
    min_dpi: T.int,
    block_below_dpi: T.int,
    allowed_file_types: T.strings,
    max_text_lines: T.int,
    status: T.str,
    is_featured: T.bool,
    rating_avg: T.decimal,
    rating_count: T.int,
    is_demo: T.bool,
    created_by: T.uuid,
  },
  { paranoid: true }
);

const ProductVariant = define("ProductVariant", "product_variants", {
  id: T.uuidPk,
  product_id: T.uuid,
  sku: T.str,
  attributes: T.json,
  color_hex: T.str,
  image: T.text,
  cost_adjust_paise: T.money,
  track_inventory: T.bool,
  stock_qty: T.int,
  low_stock_threshold: T.int,
  is_active: T.bool,
});

const PrintArea = define(
  "PrintArea",
  "print_areas",
  {
    id: T.uuidPk,
    product_id: T.uuid,
    code: T.str,
    name: T.str,
    width_mm: T.decimal,
    height_mm: T.decimal,
    safe_margin_mm: T.decimal,
    box: T.json,
    allowed_methods: T.strings,
    max_text_chars: T.int,
    sort_order: T.int,
  },
  { timestamps: false }
);

const ProductMethod = define(
  "ProductMethod",
  "product_methods",
  {
    id: T.intPk,
    product_id: T.uuid,
    method_id: T.int,
    cost_per_unit_paise: T.money,
    setup_fee_paise: T.money,
    moq: T.int,
    is_default: T.bool,
  },
  { timestamps: false }
);

const PriceTier = define(
  "PriceTier",
  "price_tiers",
  { id: T.intPk, product_id: T.uuid, min_qty: T.int, max_qty: T.int, margin_pct: T.decimal, checkout_path: T.str },
  { timestamps: false }
);

const BundleItem = define(
  "BundleItem",
  "bundle_items",
  { id: T.intPk, kit_product_id: T.uuid, component_product_id: T.uuid, component_variant_id: T.uuid, quantity: T.int },
  { timestamps: false }
);

const ProductSource = define(
  "ProductSource",
  "product_sources",
  {
    id: T.intPk,
    product_id: T.uuid,
    source: T.str,
    vendor_id: T.uuid,
    cost_paise: T.money,
    lead_time_days: T.int,
    is_default: T.bool,
  },
  { timestamps: false }
);

const InventoryMovement = define(
  "InventoryMovement",
  "inventory_movements",
  {
    id: T.bigPk,
    variant_id: T.uuid,
    change_qty: T.int,
    balance_after: T.int,
    reason: T.str,
    reference_type: T.str,
    reference_id: T.uuid,
    note: T.text,
    created_by: T.uuid,
  },
  { timestamps: "created" }
);

const Wishlist = define(
  "Wishlist",
  "wishlists",
  { user_id: { type: T.uuid, primaryKey: true }, product_id: { type: T.uuid, primaryKey: true } },
  { timestamps: "created" }
);

module.exports = {
  Company,
  CompanyMember,
  Address,
  BrandKit,
  DecorationMethod,
  Vendor,
  VendorUser,
  VendorCapability,
  VendorHoliday,
  Category,
  Product,
  ProductVariant,
  PrintArea,
  ProductMethod,
  PriceTier,
  BundleItem,
  ProductSource,
  InventoryMovement,
  Wishlist,
};
