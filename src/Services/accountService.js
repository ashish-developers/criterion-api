// Customer self-service: profile, addresses, wishlist and notifications. Every query is
// scoped to the signed-in user (or their company for company addresses).
const { Op } = require("sequelize");
const { sequelize, User, Address, Wishlist, Product, Notification } = require("../Models");
const ApiError = require("../Utils/ApiError");
const catalogService = require("./catalogService");

async function updateProfile(userId, { name, phone, marketingOptIn }) {
  const user = await User.findByPk(userId);
  await user.update({ name, phone, marketing_opt_in: Boolean(marketingOptIn) });
  return user;
}

function addressScope(auth, { company = false } = {}) {
  if (company) {
    if (!auth.companyId) throw ApiError.forbidden("A company account is required", "COMPANY_REQUIRED");
    return { company_id: auth.companyId };
  }
  return { user_id: auth.user.id };
}

async function listAddresses(auth) {
  const where = auth.companyId
    ? { [Op.or]: [{ user_id: auth.user.id }, { company_id: auth.companyId }] }
    : { user_id: auth.user.id };
  return Address.findAll({ where, order: [["is_default", "DESC"], ["created_at", "DESC"]] });
}

async function findAddress(auth, id) {
  const address = await Address.findByPk(id);
  const owns = address && (address.user_id === auth.user.id || (auth.companyId && address.company_id === auth.companyId));
  if (!owns) throw ApiError.notFound("Address not found");
  return address;
}

async function saveAddress(auth, data, id) {
  const forCompany = Boolean(data.forCompany);
  if (forCompany && !auth.permissions.has("company.manage")) throw ApiError.forbidden("Only company admins can edit company addresses");
  return sequelize.transaction(async (transaction) => {
    let address;
    if (id) {
      address = await findAddress(auth, id);
      if (address.company_id && !auth.permissions.has("company.manage")) throw ApiError.forbidden("Only company admins can edit company addresses");
    }
    const scope = id ? (address.company_id ? { company_id: address.company_id } : { user_id: address.user_id }) : addressScope(auth, { company: forCompany });
    if (data.is_default) await Address.update({ is_default: false }, { where: { ...scope, type: data.type }, transaction });
    const fields = { ...data };
    delete fields.forCompany;
    if (address) return address.update(fields, { transaction });
    return Address.create({ ...fields, ...scope }, { transaction });
  });
}

async function deleteAddress(auth, id) {
  const address = await findAddress(auth, id);
  if (address.company_id && !auth.permissions.has("company.manage")) throw ApiError.forbidden("Only company admins can delete company addresses");
  await address.destroy();
}

async function wishlist(userId) {
  const rows = await Wishlist.findAll({ where: { user_id: userId }, order: [["created_at", "DESC"]] });
  if (!rows.length) return [];
  const products = await Product.findAll({ where: { id: rows.map((r) => r.product_id), status: "active" }, include: catalogService.PRODUCT_INCLUDES });
  const byId = new Map(products.map((p) => [p.id, catalogService.summarise(p)]));
  return rows.map((r) => byId.get(r.product_id)).filter(Boolean);
}

async function addToWishlist(userId, productId) {
  const product = await Product.findOne({ where: { id: productId, status: "active" } });
  if (!product) throw ApiError.notFound("Product not found");
  await Wishlist.findOrCreate({ where: { user_id: userId, product_id: productId } });
}

async function removeFromWishlist(userId, productId) {
  await Wishlist.destroy({ where: { user_id: userId, product_id: productId } });
}

async function notifications(userId, { limit = 20, unreadOnly = false } = {}) {
  const where = { user_id: userId };
  if (unreadOnly) where.read_at = null;
  const [items, unread] = await Promise.all([
    Notification.findAll({ where, order: [["created_at", "DESC"]], limit }),
    Notification.count({ where: { user_id: userId, read_at: null } }),
  ]);
  return { items, unread };
}

async function markNotificationsRead(userId, ids) {
  const where = { user_id: userId, read_at: null };
  if (ids && ids.length) where.id = ids;
  await Notification.update({ read_at: new Date() }, { where });
}

module.exports = {
  updateProfile,
  listAddresses,
  findAddress,
  saveAddress,
  deleteAddress,
  wishlist,
  addToWishlist,
  removeFromWishlist,
  notifications,
  markNotificationsRead,
};
