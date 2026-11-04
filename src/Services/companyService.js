// B2B company accounts (FR-BB-01, 04, 05, 06, 07): profile and billing, team members with
// roles, brand kit, invoices and recipient CSV parsing for multi-address delivery.
const { Op } = require("sequelize");
const { sequelize, Company, CompanyMember, User, BrandKit, ArtworkAsset, Order } = require("../Models");
const ApiError = require("../Utils/ApiError");
const authService = require("./authService");
const assetService = require("./assetService");
const invoiceService = require("./invoiceService");

const ROLE_FOR_MEMBER = { admin: "business_admin", approver: "business_approver", buyer: "business_buyer" };

async function profile(auth) {
  const company = await Company.findByPk(auth.companyId);
  if (!company) throw ApiError.notFound("Company not found");
  const [stats] = await sequelize.query(
    `SELECT count(*)::int AS orders, COALESCE(sum(total_paise),0)::bigint AS spend,
            COALESCE(sum(CASE WHEN payment_terms IN ('credit_15','credit_30') THEN total_paise - amount_paid_paise ELSE 0 END),0)::bigint AS outstanding
       FROM orders WHERE company_id = :id AND status NOT IN ('cancelled','refunded')`,
    { replacements: { id: company.id } }
  );
  return { ...company.toJSON(), stats: { orders: stats[0].orders, spendPaise: Number(stats[0].spend), outstandingPaise: Number(stats[0].outstanding) } };
}

async function update(auth, data) {
  const company = await Company.findByPk(auth.companyId);
  if (data.gstin && data.gstin !== company.gstin) {
    const taken = await Company.findOne({ where: { gstin: data.gstin, id: { [Op.ne]: company.id } } });
    if (taken) throw ApiError.conflict("Another company is registered with this GSTIN", "GSTIN_TAKEN");
  }
  // Commercial terms (credit, limits, payment terms) are controlled by the platform admin.
  const allowed = ["name", "legal_name", "gstin", "pan", "industry", "company_size", "website", "billing_email", "billing_phone", "billing_address", "approval_limit_paise"];
  const patch = Object.fromEntries(Object.entries(data).filter(([k]) => allowed.includes(k)));
  await company.update(patch);
  return profile(auth);
}

async function team(auth) {
  const members = await CompanyMember.findAll({
    where: { company_id: auth.companyId, status: { [Op.ne]: "removed" } },
    include: [{ model: User, as: "user", attributes: ["id", "name", "email", "phone", "status", "last_login_at"] }],
    order: [["created_at", "ASC"]],
  });
  return members.map((m) => ({ id: m.id, role: m.member_role, status: m.status, user: m.user, joinedAt: m.created_at }));
}

async function updateMember(auth, memberId, { role, remove }) {
  return sequelize.transaction(async (transaction) => {
    const member = await CompanyMember.findOne({ where: { id: memberId, company_id: auth.companyId }, transaction });
    if (!member) throw ApiError.notFound("Team member not found");
    if (member.user_id === auth.user.id) throw ApiError.forbidden("You cannot change your own role");
    const { UserRole, Role } = require("../Models");
    const roles = await Role.findAll({ where: { code: Object.values(ROLE_FOR_MEMBER) }, transaction });
    await UserRole.destroy({ where: { user_id: member.user_id, scope_type: "company", scope_id: auth.companyId, role_id: roles.map((r) => r.id) }, transaction });
    if (remove) {
      await member.update({ status: "removed" }, { transaction });
      return member;
    }
    await member.update({ member_role: role }, { transaction });
    const user = await User.findByPk(member.user_id, { transaction });
    if (user.status === "active") await authService.assignRole(user.id, ROLE_FOR_MEMBER[role], "company", auth.companyId, transaction);
    return member;
  });
}

async function brandKits(auth) {
  const kits = await BrandKit.findAll({ where: { company_id: auth.companyId }, order: [["created_at", "ASC"]] });
  const assets = await ArtworkAsset.findAll({ where: { company_id: auth.companyId }, order: [["created_at", "DESC"]] });
  return {
    kits: kits.map((k) => ({ ...k.toJSON(), assets: assets.filter((a) => a.brand_kit_id === k.id).map(assetService.present) })),
    assets: assets.map(assetService.present),
  };
}

async function saveBrandKit(auth, data, id) {
  if (id) {
    const kit = await BrandKit.findOne({ where: { id, company_id: auth.companyId } });
    if (!kit) throw ApiError.notFound("Brand kit not found");
    return kit.update(data);
  }
  return BrandKit.create({ ...data, company_id: auth.companyId });
}

async function deleteBrandKit(auth, id) {
  const kit = await BrandKit.findOne({ where: { id, company_id: auth.companyId } });
  if (!kit) throw ApiError.notFound("Brand kit not found");
  await ArtworkAsset.update({ brand_kit_id: null }, { where: { brand_kit_id: kit.id } });
  await kit.destroy();
}

async function invoices(auth) {
  return invoiceService.listForCompany(auth.companyId);
}

// Purchase orders: company orders with PO numbers, terms and outstanding balances.
async function purchaseOrders(auth) {
  const orders = await Order.findAll({
    where: { company_id: auth.companyId, [Op.or]: [{ po_number: { [Op.ne]: null } }, { payment_terms: { [Op.in]: ["credit_15", "credit_30", "advance_50"] } }] },
    include: [{ model: User, as: "customer", attributes: ["id", "name"] }],
    order: [["placed_at", "DESC"]],
  });
  return orders.map((o) => ({
    id: o.id,
    orderNumber: o.order_number,
    poNumber: o.po_number,
    placedBy: o.customer?.name,
    placedAt: o.placed_at,
    paymentTerms: o.payment_terms,
    totalPaise: o.total_paise,
    paidPaise: o.amount_paid_paise,
    outstandingPaise: Math.max(0, o.total_paise - o.amount_paid_paise),
    status: o.status,
    paymentStatus: o.payment_status,
  }));
}

/**
 * Parses a recipients CSV (FR-BB-06). Columns: name, size, phone, address, city, state, pincode
 * (header row required; order independent). Returns recipients and the size breakdown.
 */
function parseRecipientsCsv(text) {
  const rows = [];
  let field = "";
  let row = [];
  let quoted = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (quoted) {
      if (c === '"' && text[i + 1] === '"') {
        field += '"';
        i++;
      } else if (c === '"') quoted = false;
      else field += c;
    } else if (c === '"') quoted = true;
    else if (c === ",") {
      row.push(field.trim());
      field = "";
    } else if (c === "\n" || c === "\r") {
      if (c === "\r" && text[i + 1] === "\n") i++;
      row.push(field.trim());
      if (row.some((v) => v)) rows.push(row);
      row = [];
      field = "";
    } else field += c;
  }
  row.push(field.trim());
  if (row.some((v) => v)) rows.push(row);
  if (rows.length < 2) throw ApiError.unprocessable("The CSV needs a header row and at least one recipient", "CSV_EMPTY");
  if (rows.length > 5001) throw ApiError.unprocessable("Up to 5,000 recipients per upload", "CSV_TOO_LARGE");

  const header = rows[0].map((h) => h.toLowerCase().replace(/[^a-z]/g, ""));
  const col = (name) => header.indexOf(name);
  const required = ["name", "address", "city", "state", "pincode"];
  const missing = required.filter((r) => col(r) === -1);
  if (missing.length) throw ApiError.unprocessable(`Missing columns: ${missing.join(", ")}`, "CSV_COLUMNS", { expected: ["name", "size", "phone", ...required] });

  const errors = [];
  const recipients = rows.slice(1).map((r, index) => {
    const get = (name) => (col(name) >= 0 ? r[col(name)] || "" : "");
    const recipient = {
      ref: `R${index + 1}`,
      name: get("name"),
      size: get("size").toUpperCase() || null,
      phone: get("phone"),
      address: get("address"),
      city: get("city"),
      state: get("state"),
      pincode: get("pincode"),
    };
    if (!recipient.name || !recipient.address || !recipient.city || !recipient.state) errors.push(`Row ${index + 2}: name, address, city and state are required`);
    if (!/^[1-9]\d{5}$/.test(recipient.pincode)) errors.push(`Row ${index + 2}: invalid PIN code "${recipient.pincode}"`);
    return recipient;
  });
  if (errors.length) throw ApiError.unprocessable(`${errors.length} row(s) need fixing`, "CSV_INVALID", { errors: errors.slice(0, 20) });
  const sizeBreakdown = {};
  for (const r of recipients) if (r.size) sizeBreakdown[r.size] = (sizeBreakdown[r.size] || 0) + 1;
  const cities = [...new Set(recipients.map((r) => r.city))];
  return { recipients, sizeBreakdown, count: recipients.length, cities };
}

module.exports = { profile, update, team,  updateMember, brandKits, saveBrandKit, deleteBrandKit, invoices, purchaseOrders, parseRecipientsCsv };
