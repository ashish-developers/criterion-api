// Visiting card designs: drafts customers create from a template, edit and later order.
//  - Individual designs belong to the signed-in user.
//  - Corporate designs belong to the user's company and are shared by its admins
//    (company.brand.manage); employees holds one row per person to print.
// Card details start from the account profile, company profile and default address, but are
// stored on the design only, so editing a card never changes the account itself.
const { Op } = require("sequelize");
const { sequelize, VcDesign, User, Company, CompanyMember, Address, BrandKit, ArtworkAsset } = require("../Models");
const ApiError = require("../Utils/ApiError");
const { readSpreadsheet } = require("../Utils/tabular");
const settingsService = require("./settingsService");
const assetService = require("./assetService");
const templates = require("./vcTemplateService");
const v = require("../Validators/vcValidators");
const { EMPLOYEE_FIELDS } = require("../Config/visitingCards");

const num = (x) => (x === null || x === undefined ? x : Number(x));

async function moduleSettings() {
  return settingsService.get("visiting_cards");
}

function access(auth, settings) {
  return {
    individual: Boolean(settings.allow_individual && auth.permissions.has("shop.purchase")),
    corporate: Boolean(settings.allow_corporate && auth.companyId && auth.permissions.has("company.brand.manage")),
  };
}

async function assertEnabled(auth, customerType) {
  const settings = await moduleSettings();
  if (!settings.enabled) throw ApiError.conflict("Visiting card orders are paused at the moment. Please try again later.", "MODULE_DISABLED");
  if (customerType && !access(auth, settings)[customerType]) {
    throw ApiError.forbidden(
      customerType === "corporate" ? "Corporate visiting cards are available to company administrators" : "Visiting cards are not available for this account",
      "VC_TYPE_NOT_ALLOWED"
    );
  }
  return settings;
}

function formatAddress(a) {
  if (!a || !a.line1) return undefined;
  const cityLine = [a.city, a.pincode].filter(Boolean).join(" - ");
  return [[a.line1, a.line2].filter(Boolean).join(", "), [cityLine, a.state].filter(Boolean).join(", ")].filter(Boolean).join("\n").slice(0, 300);
}

const compact = (o) => Object.fromEntries(Object.entries(o).filter(([, val]) => val !== undefined && val !== null && val !== ""));

/** Card details pre-filled from the account (and company) for a new design. */
async function profileDefaults(auth, customerType) {
  const user = await User.findByPk(auth.user.id);
  const company = auth.companyId ? await Company.findByPk(auth.companyId) : null;
  const address = await Address.findOne({ where: { user_id: user.id, type: "shipping" }, order: [["is_default", "DESC"], ["created_at", "DESC"]] });
  const companyAddress = company ? formatAddress(company.billing_address) : undefined;
  const person = compact({ fullName: user.name, designation: user.designation, mobile: user.phone, email: user.email });
  if (customerType === "corporate") {
    return {
      fields: compact({ company: company?.name, website: company?.website, phone: company?.billing_phone, address: companyAddress }),
      // Start the list with the admin themselves; they add the rest of the team.
      employees: [{ ref: "e1", ...person }],
    };
  }
  return {
    fields: compact({ ...person, company: company?.name, website: company?.website, address: companyAddress || formatAddress(address) }),
    employees: [],
  };
}

async function context(auth) {
  const settings = await moduleSettings();
  const allowed = access(auth, settings);
  const company = auth.companyId ? await Company.findByPk(auth.companyId, { attributes: ["id", "name", "website", "gstin"] }) : null;
  let branding = null;
  if (allowed.corporate) {
    const kits = await BrandKit.findAll({ where: { company_id: auth.companyId }, order: [["created_at", "ASC"]] });
    const logos = await ArtworkAsset.findAll({
      where: { company_id: auth.companyId, mime_type: { [Op.in]: ["image/png", "image/jpeg", "image/svg+xml", "image/webp"] } },
      order: [["created_at", "DESC"]],
      limit: 30,
    });
    branding = { kits: kits.map((k) => ({ id: k.id, name: k.name, colors: k.colors, fonts: k.fonts })), logos: logos.map(assetService.present) };
  }
  return {
    enabled: Boolean(settings.enabled),
    access: allowed,
    minOrderQty: settings.min_order_qty,
    minQtyPerCard: settings.min_qty_per_card,
    maxQtyPerCard: settings.max_qty_per_card,
    maxEmployeesPerOrder: settings.max_employees_per_order,
    artworkReviewRequired: Boolean(settings.artwork_review_required),
    productionDays: settings.production_days,
    company: company ? { id: company.id, name: company.name, website: company.website, gstin: company.gstin } : null,
    profile: {
      individual: allowed.individual ? (await profileDefaults(auth, "individual")).fields : null,
      corporate: allowed.corporate ? await profileDefaults(auth, "corporate") : null,
    },
    branding,
  };
}

// ---------------------------------------------------------------- access to designs
// Own individual designs, plus the company's corporate designs for its admins. A corporate
// design stays with the company: someone who has left it, or lost admin rights, cannot open it.
function visibleWhere(auth) {
  const own = { user_id: auth.user.id, customer_type: "individual" };
  if (auth.companyId && auth.permissions.has("company.brand.manage")) return { [Op.or]: [own, { company_id: auth.companyId, customer_type: "corporate" }] };
  return own;
}

async function load(auth, id, { transaction, lock } = {}) {
  const design = await VcDesign.findOne({ where: { id, ...visibleWhere(auth) }, transaction, lock });
  if (!design) throw ApiError.notFound("Design not found");
  return design;
}

function present(d, { full = true } = {}) {
  const out = {
    id: d.id,
    name: d.name,
    customerType: d.customer_type,
    companyId: d.company_id,
    templateId: d.template_id,
    templateName: d.template?.name || null,
    orientation: d.orientation,
    widthMm: num(d.width_mm),
    heightMm: num(d.height_mm),
    status: d.status,
    approvedAt: d.approved_at,
    lastOrderedAt: d.last_ordered_at,
    employeeCount: (d.employees || []).length,
    ownerName: d.owner?.name,
    updatedAt: d.updated_at,
    design: d.design,
    fields: d.fields,
  };
  if (full) {
    out.employees = d.employees;
    out.templateDesign = d.template_design;
  }
  return out;
}

async function list(auth) {
  const rows = await VcDesign.findAll({
    where: visibleWhere(auth),
    include: [
      { association: "template", attributes: ["id", "name"], paranoid: false },
      { association: "owner", attributes: ["id", "name"] },
    ],
    order: [["updated_at", "DESC"]],
    limit: 100,
  });
  return rows.map((d) => present(d, { full: false }));
}

async function get(auth, id) {
  const design = await load(auth, id);
  await design.reload({ include: [{ association: "template", attributes: ["id", "name", "bleed_mm", "safe_margin_mm"], paranoid: false }, { association: "owner", attributes: ["id", "name"] }] });
  return {
    ...present(design),
    bleedMm: num(design.template?.bleed_mm ?? 3),
    safeMarginMm: num(design.template?.safe_margin_mm ?? 3),
  };
}

async function create(auth, { templateId, customerType, name }) {
  await assertEnabled(auth, customerType);
  const template = await templates.publishedTemplate(templateId);
  const defaults = await profileDefaults(auth, customerType);
  const company = customerType === "corporate" ? await Company.findByPk(auth.companyId) : null;
  const owner = customerType === "corporate" ? company.name : auth.user.name;
  const design = await sequelize.transaction(async (transaction) => {
    const row = await VcDesign.create(
      {
        user_id: auth.user.id,
        company_id: customerType === "corporate" ? auth.companyId : null,
        customer_type: customerType,
        template_id: template.id,
        name: (name || `${owner} - ${template.name}`).slice(0, 120),
        orientation: template.orientation,
        width_mm: template.width_mm,
        height_mm: template.height_mm,
        design: template.design,
        template_design: template.design,
        fields: defaults.fields,
        employees: defaults.employees,
      },
      { transaction }
    );
    await template.increment("usage_count", { transaction });
    return row;
  });
  return get(auth, design.id);
}

/** Image assets referenced by the card details must be the user's own (or company) images. */
async function checkAssets(auth, fields) {
  const ids = [fields.logoAssetId, fields.photoAssetId].filter(Boolean);
  const assets = await assetService.assertUsable(auth, ids);
  if (assets.some((a) => !a.mime_type.startsWith("image/"))) {
    throw ApiError.unprocessable("Logos and photos must be PNG, JPG or SVG images", "ASSET_NOT_IMAGE", { logoAssetId: "Upload an image" });
  }
}

/** Employee rows: count limit, and rows are only allowed on corporate designs. */
function checkEmployees(customerType, employees, settings) {
  if (customerType !== "corporate" && employees.length) {
    throw ApiError.unprocessable("Employee lists are only used on corporate cards", "VALIDATION_FAILED", { employees: "Not allowed" });
  }
  if (employees.length > settings.max_employees_per_order) {
    throw ApiError.unprocessable(`Add at most ${settings.max_employees_per_order} people to one order`, "TOO_MANY_EMPLOYEES", { employees: "Too many rows" });
  }
}

function dimensionsFor(design, orientation) {
  const a = num(design.width_mm);
  const b = num(design.height_mm);
  const long = Math.max(a, b);
  const short = Math.min(a, b);
  return orientation === "landscape" ? { width_mm: long, height_mm: short } : { width_mm: short, height_mm: long };
}

async function save(auth, id, data) {
  const settings = await moduleSettings();
  const design = await load(auth, id);
  checkEmployees(design.customer_type, data.employees, settings);
  await checkAssets(auth, data.fields);
  const employees = data.employees.map((e, i) => ({ ...e, ref: e.ref || `e${i + 1}` }));
  await design.update({ name: data.name, orientation: data.orientation, ...dimensionsFor(design, data.orientation), design: data.design, fields: data.fields, employees });
  return get(auth, design.id);
}

async function duplicate(auth, id) {
  const source = await load(auth, id);
  await assertEnabled(auth, source.customer_type);
  const copy = await VcDesign.create({
    user_id: auth.user.id,
    company_id: source.company_id,
    customer_type: source.customer_type,
    template_id: source.template_id,
    name: `${source.name} (copy)`.slice(0, 120),
    orientation: source.orientation,
    width_mm: source.width_mm,
    height_mm: source.height_mm,
    design: source.design,
    template_design: source.template_design,
    fields: source.fields,
    employees: source.employees,
  });
  return get(auth, copy.id);
}

async function remove(auth, id) {
  const design = await load(auth, id);
  await design.destroy();
}

// ---------------------------------------------------------------- employees
const HEADER_ALIASES = {
  employeeCode: ["employeecode", "employeeid", "empcode", "empid", "staffid", "code", "id"],
  fullName: ["fullname", "name", "employeename", "employee", "nameoncard"],
  designation: ["designation", "title", "jobtitle", "role", "position"],
  department: ["department", "dept", "team", "division"],
  mobile: ["mobile", "mobilenumber", "mobileno", "cell", "cellphone", "whatsapp"],
  phone: ["phone", "phonenumber", "office", "officephone", "landline", "telephone", "tel", "direct"],
  email: ["email", "emailaddress", "mail", "emailid", "workemail"],
  address: ["address", "officeaddress", "location", "branch", "branchaddress"],
  quantity: ["quantity", "qty", "cards", "numberofcards", "noofcards"],
};

function headerKey(cell) {
  const norm = String(cell).toLowerCase().replace(/[^a-z]/g, "");
  return Object.entries(HEADER_ALIASES).find(([, aliases]) => aliases.includes(norm))?.[0] || null;
}

function issuesToErrors(issues) {
  const errors = {};
  for (const issue of issues) {
    const field = issue.path.join(".") || "row";
    if (!errors[field]) errors[field] = issue.message;
  }
  return errors;
}

/** Validates employee rows (from a file or the table) and flags repeated emails or codes. */
function validateRows(rawRows, settings, { firstRowNo = 1 } = {}) {
  const seen = { email: new Map(), employeeCode: new Map() };
  return rawRows.map((raw, i) => {
    const rowNo = firstRowNo + i;
    const parsed = v.employee.safeParse(raw);
    const errors = parsed.success ? {} : issuesToErrors(parsed.error.issues);
    const data = parsed.success ? parsed.data : raw;
    if (parsed.success && data.quantity && data.quantity < settings.min_qty_per_card) errors.quantity = `At least ${settings.min_qty_per_card} cards per person`;
    if (parsed.success && data.quantity && data.quantity > settings.max_qty_per_card) errors.quantity = `At most ${settings.max_qty_per_card} cards per person`;
    for (const key of ["email", "employeeCode"]) {
      const value = data[key] ? String(data[key]).toLowerCase() : "";
      if (!value) continue;
      if (seen[key].has(value)) errors[key] = errors[key] || `Same ${key === "email" ? "email" : "employee code"} as row ${seen[key].get(value)}`;
      else seen[key].set(value, rowNo);
    }
    return { rowNo, data, errors, valid: Object.keys(errors).length === 0 };
  });
}

async function importEmployees(auth, file) {
  const settings = await assertEnabled(auth, "corporate");
  const rows = readSpreadsheet(file, { maxRows: settings.max_employees_per_order });
  if (rows.length < 2) throw ApiError.unprocessable("The file needs a header row and at least one person", "FILE_EMPTY");
  const keys = rows[0].map(headerKey);
  const expected = ["Employee code", "Full name", "Designation", "Department", "Mobile", "Phone", "Email", "Address", "Quantity"];
  if (!keys.includes("fullName")) {
    throw ApiError.unprocessable("The file needs a Name (or Full name) column", "COLUMNS_MISSING", { expected });
  }
  const unknownColumns = rows[0].filter((h, i) => h && !keys[i]);
  const records = rows.slice(1).map((cells) => {
    const record = {};
    keys.forEach((key, i) => {
      if (key && cells[i] !== undefined && cells[i] !== "") record[key] = cells[i];
    });
    return record;
  });
  const results = validateRows(records, settings, { firstRowNo: 2 });
  return {
    columns: [...new Set(keys.filter(Boolean))],
    unknownColumns,
    expected,
    rows: results,
    validCount: results.filter((r) => r.valid).length,
    errorCount: results.filter((r) => !r.valid).length,
  };
}

async function directory(auth) {
  await assertEnabled(auth, "corporate");
  const members = await CompanyMember.findAll({
    where: { company_id: auth.companyId, status: { [Op.ne]: "removed" } },
    include: [{ model: User, as: "user", attributes: ["id", "name", "email", "phone", "designation", "status"] }],
    order: [["created_at", "ASC"]],
  });
  return members
    .filter((m) => m.user)
    .map((m) => ({ userId: m.user.id, role: m.member_role, status: m.user.status, row: compact({ fullName: m.user.name, designation: m.user.designation, email: m.user.email, mobile: m.user.phone }) }));
}

// ---------------------------------------------------------------- cards for an order
const PRINTED = ["fullName", "designation", "department", "company", "tagline", "mobile", "phone", "email", "website", "address", "logoAssetId", "photoAssetId"];

/**
 * The cards an order prints: one for an individual, one per employee for a corporate design
 * (company-wide details plus that person's own). Returns { cards, problems } where problems
 * are the reasons the order cannot be placed yet.
 */
function cardsFor(design, defaultQuantity, settings) {
  const base = Object.fromEntries(PRINTED.filter((k) => design.fields?.[k]).map((k) => [k, design.fields[k]]));
  const problems = [];
  let cards;
  if (design.customer_type === "corporate") {
    const rows = validateRows(design.employees || [], settings);
    const invalid = rows.filter((r) => !r.valid);
    if (!rows.length) problems.push({ code: "NO_EMPLOYEES", message: "Add at least one person to print cards for" });
    if (invalid.length) problems.push({ code: "EMPLOYEE_ERRORS", message: `Fix ${invalid.length} employee row(s) before ordering`, rows: invalid.map((r) => ({ rowNo: r.rowNo, errors: r.errors })) });
    cards = rows.map((r, i) => {
      const own = Object.fromEntries(EMPLOYEE_FIELDS.filter((k) => r.data[k]).map((k) => [k, r.data[k]]));
      return { lineNo: i + 1, fields: { ...base, ...own }, quantity: r.data.quantity || defaultQuantity };
    });
  } else {
    cards = [{ lineNo: 1, fields: base, quantity: defaultQuantity }];
    if (!base.fullName) problems.push({ code: "NAME_REQUIRED", message: "Add your name to the card" });
  }
  const perCardLow = cards.filter((c) => c.quantity < settings.min_qty_per_card);
  if (perCardLow.length) problems.push({ code: "MIN_PER_CARD", message: `Each person needs at least ${settings.min_qty_per_card} cards` });
  if (cards.some((c) => c.quantity > settings.max_qty_per_card)) problems.push({ code: "MAX_PER_CARD", message: `At most ${settings.max_qty_per_card} cards per person` });
  const total = cards.reduce((s, c) => s + c.quantity, 0);
  if (total < settings.min_order_qty) problems.push({ code: "MIN_ORDER_QUANTITY", message: `The minimum order is ${settings.min_order_qty} visiting cards` });
  if (cards.length > settings.max_employees_per_order) problems.push({ code: "TOO_MANY_EMPLOYEES", message: `Add at most ${settings.max_employees_per_order} people to one order` });
  return { cards, problems, totalQuantity: total };
}

module.exports = { context, list, get, create, save, duplicate, remove, load, importEmployees, directory, cardsFor, validateRows, checkAssets, checkEmployees, assertEnabled, moduleSettings, access, profileDefaults, formatAddress };
