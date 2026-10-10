// Product reviews with photos, moderated before publishing (FR-CS-08).
const { sequelize, Review, Product, User } = require("../Models");
const ApiError = require("../Utils/ApiError");
const assetService = require("./assetService");

async function create(auth, { productId, rating, title, body, photoAssetIds = [] }) {
  // Only buyers who received the product can review it.
  const [rows] = await sequelize.query(
    `SELECT oi.id FROM order_items oi JOIN orders o ON o.id = oi.order_id
      WHERE o.user_id = :userId AND oi.product_id = :productId AND oi.state IN ('delivered','closed') LIMIT 1`,
    { replacements: { userId: auth.user.id, productId } }
  );
  if (!rows.length) throw ApiError.forbidden("You can review products after they are delivered");
  if (photoAssetIds.length) await assetService.assertUsable(auth, photoAssetIds);
  const existing = await Review.findOne({ where: { user_id: auth.user.id, product_id: productId } });
  if (existing) return existing.update({ rating, title, body, photo_asset_ids: photoAssetIds, status: "pending" });
  return Review.create({ product_id: productId, user_id: auth.user.id, order_item_id: rows[0].id, rating, title, body, photo_asset_ids: photoAssetIds });
}

async function forProduct(productId) {
  const reviews = await Review.findAll({
    where: { product_id: productId, status: "approved" },
    include: [{ model: User, as: "user", attributes: ["name"] }],
    order: [["created_at", "DESC"]],
    limit: 50,
  });
  return reviews.map((r) => ({
    id: r.id,
    rating: r.rating,
    title: r.title,
    body: r.body,
    author: r.user ? r.user.name.split(" ")[0] : "Customer",
    photos: r.photo_asset_ids.map((id) => `/api/v1/assets/${id}`),
    at: r.created_at,
  }));
}

async function moderate(reviewId, status) {
  const review = await Review.findByPk(reviewId);
  if (!review) throw ApiError.notFound("Review not found");
  await review.update({ status });
  // Photo attachments become public once a review is approved.
  if (status === "approved" && review.photo_asset_ids.length) {
    await sequelize.query(`UPDATE artwork_assets SET is_public = true WHERE id = ANY(:ids)`, { replacements: { ids: review.photo_asset_ids } });
  }
  const [agg] = await sequelize.query(
    `SELECT COALESCE(avg(rating),0) AS avg, count(*)::int AS n FROM reviews WHERE product_id = :id AND status = 'approved'`,
    { replacements: { id: review.product_id } }
  );
  await Product.update({ rating_avg: Number(agg[0].avg).toFixed(2), rating_count: agg[0].n }, { where: { id: review.product_id } });
  return review;
}

async function list({ status = "pending", page = 1, limit = 20 }) {
  const { rows, count } = await Review.findAndCountAll({
    where: status ? { status } : {},
    include: [{ model: User, as: "user", attributes: ["id", "name", "email"] }, { model: Product, as: "product", attributes: ["id", "name", "slug"] }],
    order: [["created_at", "DESC"]],
    limit,
    offset: (page - 1) * limit,
  });
  return { items: rows, total: count };
}

module.exports = { create, forProduct, moderate, list };
