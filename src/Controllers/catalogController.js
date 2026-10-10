const catalogService = require("../Services/catalogService");
const { ok, pageMeta } = require("../Utils/http");

const categories = async (req, res) => ok(res, await catalogService.categoryTree());

const category = async (req, res) => ok(res, await catalogService.categoryBySlug(req.params.slug));

const products = async (req, res) => {
  const query = req.validatedQuery;
  const result = await catalogService.searchProducts(query);
  return ok(res, result.items, "OK", { ...pageMeta(query, result.total), facets: result.facets });
};

const product = async (req, res) => ok(res, await catalogService.productDetail(req.params.slug));

const price = async (req, res) => ok(res, await catalogService.priceQuote(req.params.id, req.validatedQuery));

const deliveryEstimate = async (req, res) => ok(res, await catalogService.deliveryEstimate(req.params.id, req.validatedQuery));

const methods = async (req, res) => ok(res, await catalogService.methods());

module.exports = { categories, category, products, product, price, deliveryEstimate, methods };
