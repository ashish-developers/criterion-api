// Tax master: GST rates and HSN/SAC codes managed by platform admins, how products pick up
// their rate, how changes flow to products, and that past orders keep the rate they were charged.
const test = require("node:test");
const assert = require("node:assert/strict");
const { Client, shutdown } = require("./helpers");

test.after(shutdown);
const state = {};

function productPayload(categoryId, overrides = {}) {
  const stamp = Date.now() + Math.floor(Math.random() * 1000);
  return {
    categoryId,
    name: `Tax Test Product ${stamp}`,
    baseCostPaise: 10000,
    hsnCode: "6912",
    moq: 1,
    maxInstantQty: 100,
    leadTimeDays: 3,
    weightGrams: 300,
    status: "active",
    variants: [{ sku: `TAX-${stamp}`, attributes: { color: "White" } }],
    priceTiers: [{ minQty: 1, marginPct: 50, checkoutPath: "instant" }],
    ...overrides,
  };
}

test("only platform admins can manage the tax master; the picker list is public", async () => {
  const admin = new Client();
  await admin.login("admin@demo.test");
  state.admin = admin;
  const rates = await admin.get("/admin/tax/rates");
  assert.equal(rates.status, 200, JSON.stringify(rates.body));
  assert.deepEqual(rates.data.filter((r) => r.isActive).map((r) => r.rate), [0, 5, 12, 18, 28, 40]);
  const r18 = rates.data.find((r) => r.rate === 18);
  assert.ok(r18.products > 0 && r18.hsnCodes > 0, "usage counts are reported");
  state.rates = Object.fromEntries(rates.data.map((r) => [r.rate, r.id]));

  for (const email of ["support@demo.test", "production@demo.test", "anjali@acme.test"]) {
    const c = new Client();
    await c.login(email);
    assert.equal((await c.get("/admin/tax/rates")).status, 403, `${email} cannot read the tax master`);
    assert.equal((await c.post("/admin/tax/rates", { name: "GST 3%", rate: 3 })).status, 403, `${email} cannot add rates`);
  }
  const options = await new Client().get("/catalog/tax-options");
  assert.equal(options.status, 200);
  assert.ok(options.data.hsnCodes.some((h) => h.code === "6912"));
});

test("rates are validated: unique names, one active entry per percentage, sensible values", async () => {
  const created = await state.admin.post("/admin/tax/rates", { name: "GST 3%", rate: 3, description: "Gold and jewellery" });
  assert.equal(created.status, 201, JSON.stringify(created.body));
  state.rates[3] = created.data.id;
  assert.equal((await state.admin.post("/admin/tax/rates", { name: "Another 18", rate: 18 })).status, 409, "duplicate active percentage");
  assert.equal((await state.admin.post("/admin/tax/rates", { name: "GST 3%", rate: 2.5 })).status, 409, "duplicate name");
  // Two decimals are allowed even where floating point is inexact (1.16 * 100 = 115.999...).
  assert.equal((await state.admin.post("/admin/tax/rates", { name: "Odd rate", rate: 1.16 })).status, 201);
  assert.equal((await state.admin.post("/admin/tax/rates", { name: "Three decimals", rate: 1.155 })).status, 422);
  const bad = await state.admin.post("/admin/tax/rates", { name: "Too much", rate: 120 });
  assert.equal(bad.status, 422);
  assert.ok(bad.body.details.rate);
});

test("HSN/SAC codes map to an active rate and must be 4, 6 or 8 digits", async () => {
  const ok = await state.admin.post("/admin/tax/hsn", { code: "711311", kind: "HSN", description: "Articles of jewellery of silver", taxRateId: state.rates[3] });
  assert.equal(ok.status, 201, JSON.stringify(ok.body));
  state.silver = ok.data;
  assert.equal((await state.admin.post("/admin/tax/hsn", { code: "12345", description: "Five digits", taxRateId: state.rates[18] })).status, 422);
  assert.equal((await state.admin.post("/admin/tax/hsn", { code: "711311", description: "Duplicate", taxRateId: state.rates[18] })).status, 409);
  const sac = await state.admin.post("/admin/tax/hsn", { code: "998912", kind: "SAC", description: "Printing services", taxRateId: state.rates[18] });
  assert.equal(sac.status, 201);
  const search = await state.admin.get("/admin/tax/hsn?q=jewellery");
  assert.equal(search.data[0].code, "711311");
  assert.equal(search.data[0].taxRate.rate, 3);
});

test("a product takes its rate from the chosen rate, else its HSN code, else its category", async () => {
  const categories = await state.admin.get("/admin/categories");
  const category = (categories.data.items || categories.data).find((c) => c.slug === "drinkware" || c.name === "Drinkware") || (categories.data.items || categories.data)[0];
  state.categoryId = category.id;

  const byHsn = await state.admin.post("/admin/products", productPayload(category.id, { hsnCode: "711311" }));
  assert.equal(byHsn.status, 201, JSON.stringify(byHsn.body));
  const { Product } = require("../src/Models");
  let p = await Product.findByPk(byHsn.data.id);
  assert.equal(Number(p.gst_rate), 3, "HSN mapping applied");
  assert.equal(p.tax_rate_id, state.rates[3]);
  state.productId = p.id;

  const chosen = await state.admin.post("/admin/products", productPayload(category.id, { hsnCode: "711311", taxRateId: state.rates[18] }));
  p = await Product.findByPk(chosen.data.id);
  assert.equal(Number(p.gst_rate), 18, "an explicit rate overrides the HSN mapping");

  const unmapped = await state.admin.post("/admin/products", productPayload(category.id, { hsnCode: "999999" }));
  assert.equal(unmapped.status, 422, "no rate, no mapping, no category default");
  assert.equal(unmapped.body.code, "TAX_RATE_REQUIRED");

  const withDefault = await state.admin.put(`/admin/categories/${category.id}`, { name: category.name, slug: category.slug, defaultTaxRateId: state.rates[5] });
  assert.equal(withDefault.status, 200, JSON.stringify(withDefault.body));
  const viaCategory = await state.admin.post("/admin/products", productPayload(category.id, { hsnCode: "999999" }));
  assert.equal(viaCategory.status, 201, JSON.stringify(viaCategory.body));
  p = await Product.findByPk(viaCategory.data.id);
  assert.equal(Number(p.gst_rate), 5, "category default applied");
  await state.admin.put(`/admin/categories/${category.id}`, { name: category.name, slug: category.slug, defaultTaxRateId: null });

  const legacy = await state.admin.post("/admin/products", productPayload(category.id, { gstRate: 18 }));
  assert.equal(legacy.status, 201, "a percentage is matched to the active rate");
  const missing = await state.admin.post("/admin/products", productPayload(category.id, { gstRate: 7 }));
  assert.equal(missing.status, 422, "percentages outside the master are refused");
});

test("changing a rate re-prices its products; past order lines keep the rate they were charged", async () => {
  const { Product, OrderItem } = require("../src/Models");
  if (!(await OrderItem.findOne({ where: { gst_rate: 12 } }))) await require("../src/Seeders/demoOrders").seedDemoOrders();
  const before = await OrderItem.findOne({ where: { gst_rate: 12 } });
  assert.ok(before, "a seeded order line at 12%");
  const edit = await state.admin.put(`/admin/tax/rates/${state.rates[12]}`, { name: "GST 12% (revised)", rate: 5.5 });
  assert.equal(edit.status, 200, JSON.stringify(edit.body));
  assert.ok(edit.data.productsUpdated > 0);
  const mug = await Product.findOne({ where: { slug: "classic-ceramic-coffee-mug" } });
  assert.equal(Number(mug.gst_rate), 5.5, "product follows the master");
  await before.reload();
  assert.equal(Number(before.gst_rate), 12, "order history unchanged");
  await state.admin.put(`/admin/tax/rates/${state.rates[12]}`, { name: "GST 12%", rate: 12 });
});

test("remapping an HSN code can move its products to the new rate", async () => {
  const moved = await state.admin.put(`/admin/tax/hsn/${state.silver.id}`, { kind: "HSN", description: "Articles of jewellery of silver", taxRateId: state.rates[5], applyToProducts: true });
  assert.equal(moved.status, 200, JSON.stringify(moved.body));
  assert.equal(moved.data.productsUpdated, 2);
  const { Product } = require("../src/Models");
  assert.equal(Number((await Product.findByPk(state.productId)).gst_rate), 5);
});

test("a rate in use cannot be deactivated; inactive rates disappear from pickers", async () => {
  const blocked = await state.admin.post(`/admin/tax/rates/${state.rates[5]}/active`, { active: false });
  assert.equal(blocked.status, 409);
  assert.match(blocked.body.message, /product/);
  const unused = await state.admin.post(`/admin/tax/rates/${state.rates[40]}/active`, { active: false });
  assert.equal(unused.status, 200, JSON.stringify(unused.body));
  const options = await new Client().get("/catalog/tax-options");
  assert.ok(!options.data.rates.some((r) => r.rate === 40), "hidden from pickers");
  const useIt = await state.admin.post("/admin/products", productPayload(state.categoryId, { taxRateId: state.rates[40] }));
  assert.equal(useIt.status, 422, "inactive rates cannot be chosen");
  assert.equal((await state.admin.post(`/admin/tax/rates/${state.rates[40]}/active`, { active: true })).status, 200);
});
