// Reference data required in every environment (production included):
// roles, permissions, decoration methods, settings defaults, policy pages and the tax master.
const { sequelize, Role, Permission, RolePermission, DecorationMethod, Setting, CmsPage, TaxRate, HsnCode } = require("../Models");
const { PERMISSIONS, ROLES } = require("../Config/roles");
const settingsService = require("../Services/settingsService");
const accessService = require("../Services/accessService");

const METHODS = [
  { code: "dtf", name: "DTF print", description: "Direct-to-film transfer, full colour, ideal for small apparel runs", default_cost_paise: 6000, default_setup_paise: 0, default_moq: 1, in_house: true },
  { code: "screen_print", name: "Screen print", description: "Economical for large runs with few colours; setup per colour", default_cost_paise: 2500, default_setup_paise: 150000, default_moq: 25, in_house: false },
  { code: "embroidery", name: "Embroidery", description: "Stitched logo; one-time digitising fee per design", default_cost_paise: 4500, default_setup_paise: 80000, default_moq: 25, in_house: false },
  { code: "sublimation", name: "Sublimation", description: "Dye sublimation for polyester, mugs and coated surfaces", default_cost_paise: 3500, default_setup_paise: 0, default_moq: 1, in_house: true },
  { code: "uv_print", name: "UV print", description: "Full-colour UV-cured print on hard surfaces", default_cost_paise: 4000, default_setup_paise: 0, default_moq: 1, in_house: true },
  { code: "laser_engraving", name: "Laser engraving", description: "Permanent engraving on metal, wood and leather", default_cost_paise: 3000, default_setup_paise: 0, default_moq: 1, in_house: true },
  { code: "pad_print", name: "Pad print", description: "Small-area print for pens and curved items", default_cost_paise: 600, default_setup_paise: 90000, default_moq: 100, in_house: false },
  { code: "debossing", name: "Debossing", description: "Pressed-in logo on leather and PU covers", default_cost_paise: 3000, default_setup_paise: 120000, default_moq: 25, in_house: false },
];

const PAGES = [
  {
    slug: "customisation-policy",
    type: "policy",
    title: "Customisation policy",
    body:
      "Every customised order line receives a digital proof before production. Production only uses the proof version you approve.\n\n" +
      "You confirm that you own, or have permission to use, every logo, photo and text you upload. We may refuse or cancel designs that infringe intellectual property or are offensive or unlawful.\n\n" +
      "Two proof revision rounds are included. Further rounds are charged as shown at the time of the request. Colours on screen can differ slightly from the printed product.",
    sort_order: 1,
  },
  {
    slug: "cancellation-policy",
    type: "policy",
    title: "Cancellation policy",
    body:
      "Before proof approval: free cancellation with a full refund.\n\n" +
      "After proof approval and before production: refund minus setup and blank costs already incurred.\n\n" +
      "In production or later: customised items cannot be cancelled because they cannot be resold.",
    sort_order: 2,
  },
  {
    slug: "returns-and-replacements",
    type: "policy",
    title: "Returns and replacements",
    body:
      "Report defects, wrong prints or transit damage within 7 days of delivery with photos. We will reprint or replace the item free of charge, or refund it if a reprint is not possible.\n\n" +
      "Errors in a proof you approved (spelling, wrong logo, wrong size selection) are not covered.",
    sort_order: 3,
  },
  {
    slug: "privacy-policy",
    type: "policy",
    title: "Privacy policy",
    body:
      "We collect the personal data needed to fulfil your orders: name, contact details, delivery addresses, GSTIN for business invoices, and the artwork you upload.\n\n" +
      "Artwork is stored privately and shared only with the production partner assigned to your order. Unordered uploads are deleted after 90 days.\n\n" +
      "You can request access, correction or erasure of your data by contacting our grievance officer. Invoices and tax records are kept as required by GST law.",
    sort_order: 4,
  },
  {
    slug: "terms-of-use",
    type: "policy",
    title: "Terms of use",
    body:
      "By using this platform you agree to provide accurate information, to upload only content you have rights to, and to pay for orders you place.\n\n" +
      "Prices shown in the cart are confirmed for standard items. Items marked as an estimate are confirmed on the quotation or proof.",
    sort_order: 5,
  },
  {
    slug: "grievance-officer",
    type: "policy",
    title: "Grievance officer",
    body:
      "Grievance Officer: Neha Kulkarni\nEmail: grievance@example.com\nPhone: +91 22 4000 0001\nAddress: Unit 4, Andheri Industrial Estate, Mumbai 400053\n\nComplaints are acknowledged within 48 hours and resolved within one month.",
    sort_order: 6,
  },
  {
    slug: "about",
    type: "page",
    title: "About us",
    body:
      "We help individuals and organisations create personalised gifts and branded merchandise: from a single photo mug to 5,000 employee welcome kits.\n\n" +
      "We print popular items in our own studio for speed and control, and work with verified partners for embroidery, engraving, large runs and regional delivery. Every custom order gets an approved proof before production.",
    sort_order: 1,
  },
  { slug: "faq-proof", type: "faq", title: "Will I see my design before it is printed?", body: "Yes. Every customised item gets a digital proof. Production starts only after you approve it, and you can request changes up to two times free of charge.", sort_order: 1 },
  { slug: "faq-bulk", type: "faq", title: "How do I order in bulk?", body: "Quantities up to the instant-checkout limit can be ordered directly with tier pricing. For larger quantities, size breakdowns or multiple delivery addresses, request a quote and we will respond within one business day.", sort_order: 2 },
  { slug: "faq-files", type: "faq", title: "Which artwork files can I upload?", body: "PNG, JPG, SVG and PDF up to 25 MB. For sharp prints use at least 150 DPI at print size; 300 DPI is recommended. Vector files (SVG, PDF) give the best results.", sort_order: 3 },
  { slug: "faq-gst", type: "faq", title: "Do you provide GST invoices?", body: "Yes. Add your GSTIN at checkout or in your company profile and a GST tax invoice is generated for every paid order.", sort_order: 4 },
  { slug: "faq-delivery", type: "faq", title: "How long does delivery take?", body: "Production lead time starts after proof approval and payment. The product page shows an estimated delivery date for your PIN code including production and shipping.", sort_order: 5 },
  { slug: "faq-cancel", type: "faq", title: "Can I cancel a customised order?", body: "You can cancel free of charge until you approve the proof. After approval, setup and blank costs are deducted. Items already in production cannot be cancelled.", sort_order: 6 },
];

// Starting GST rates. Admins manage them under Settings -> Taxes; seeding only adds rates that
// are missing and never changes ones an admin has edited. Confirm rates with a tax adviser:
// the September 2025 GST rationalisation moved most goods to 5% or 18% and added 40%.
const TAX_RATES = [
  { name: "Nil rated (0%)", rate: 0, description: "Exempt or nil-rated supplies" },
  { name: "GST 5%", rate: 5, description: "Merit rate" },
  { name: "GST 12%", rate: 12, description: "Earlier slab; most goods moved to 5% or 18% from 22 Sep 2025. Review before use." },
  { name: "GST 18%", rate: 18, description: "Standard rate" },
  { name: "GST 28%", rate: 28, description: "Earlier slab; most goods moved to 18% or 40% from 22 Sep 2025. Review before use." },
  { name: "GST 40%", rate: 40, description: "Special rate (luxury and sin goods)" },
];

// HSN codes for the gift and merchandise range, with the rates the catalogue uses today.
const HSN_CODES = [
  ["4202", "Trunks, suitcases, handbags, backpacks and similar containers", 18],
  ["4414", "Wooden frames for paintings, photographs, mirrors or similar objects", 12],
  ["4420", "Wood marquetry, caskets, statuettes and other ornaments of wood", 12],
  ["4819", "Cartons, boxes and cases of paper or paperboard (gift boxes, hampers)", 18],
  ["4820", "Registers, notebooks, diaries, planners and similar articles of paper", 18],
  ["6105", "Men's or boys' shirts, knitted or crocheted (polo shirts)", 5],
  ["6109", "T-shirts, singlets and other vests, knitted or crocheted", 5],
  ["6110", "Jerseys, pullovers, sweatshirts and hoodies, knitted or crocheted", 5],
  ["6305", "Sacks and bags of textile materials used for packing (tote bags)", 5],
  ["6307", "Other made-up textile articles (lanyards, badges, pouches)", 12],
  ["6505", "Hats and other headgear, knitted or made up from textile", 5],
  ["6912", "Ceramic tableware and kitchenware other than porcelain (mugs)", 12],
  ["7323", "Table, kitchen or household articles of iron or steel (bottles, tumblers)", 12],
  ["7326", "Other articles of iron or steel (metal keychains)", 18],
  ["8306", "Statuettes, trophies and other ornaments of base metal", 18],
  ["9608", "Ball point pens, felt-tipped pens and markers", 18],
];

async function seedTaxMaster(transaction) {
  for (const def of TAX_RATES) {
    const existing = await TaxRate.findOne({ where: { name: def.name }, transaction });
    const sameRate = await TaxRate.findOne({ where: { rate: def.rate, is_active: true }, transaction });
    if (!existing && !sameRate) await TaxRate.create({ ...def, sort_order: Math.round(def.rate * 100), is_active: true }, { transaction });
    // Rates created by the migration backfill have no description yet.
    else if ((existing || sameRate).name === def.name && !(existing || sameRate).description) await (existing || sameRate).update({ description: def.description }, { transaction });
  }
  for (const [code, description, rate] of HSN_CODES) {
    const existing = await HsnCode.findOne({ where: { code }, transaction });
    if (existing) {
      // Codes created by the migration backfill only have a placeholder description.
      if (existing.description === `HSN ${code}`) await existing.update({ description }, { transaction });
      continue;
    }
    const taxRate = await TaxRate.findOne({ where: { rate, is_active: true }, transaction });
    if (taxRate) await HsnCode.create({ code, kind: "HSN", description, tax_rate_id: taxRate.id, is_active: true }, { transaction });
  }
}

async function seedReference() {
  await sequelize.transaction(async (transaction) => {
    for (const [code, [module, description]] of Object.entries(PERMISSIONS)) {
      await Permission.upsert({ code, module, description }, { transaction, conflictFields: ["code"] });
    }
    const permissions = await Permission.findAll({ transaction });
    const permissionId = new Map(permissions.map((p) => [p.code, p.id]));

    for (const [code, def] of Object.entries(ROLES)) {
      await Role.upsert({ code, name: def.name, scope_type: def.scope, description: `${def.name} (${def.portal} portal)` }, { transaction, conflictFields: ["code"] });
      const role = await Role.findOne({ where: { code }, transaction });
      // Built-in roles are reset to their defined permissions on every seed run.
      await RolePermission.destroy({ where: { role_id: role.id }, transaction });
      await RolePermission.bulkCreate(def.permissions.map((p) => ({ role_id: role.id, permission_id: permissionId.get(p) })), { transaction });
    }

    for (const method of METHODS) {
      const existing = await DecorationMethod.findOne({ where: { code: method.code }, transaction });
      if (existing) await existing.update(method, { transaction });
      else await DecorationMethod.create(method, { transaction });
    }

    for (const [key, def] of Object.entries(settingsService.DEFAULTS)) {
      const existing = await Setting.findByPk(key, { transaction });
      if (!existing) await Setting.create({ key, value: def.value, description: def.description, updated_at: new Date() }, { transaction });
    }

    for (const page of PAGES) {
      const existing = await CmsPage.findOne({ where: { slug: page.slug }, transaction });
      if (!existing) await CmsPage.create(page, { transaction });
    }

    await seedTaxMaster(transaction);
  });
  accessService.invalidateRoleCache();
  settingsService.clearCache();
  console.log(`Reference data: ${Object.keys(PERMISSIONS).length} permissions, ${Object.keys(ROLES).length} roles, ${METHODS.length} methods, ${PAGES.length} pages`);
}

module.exports = { seedReference, METHODS };
