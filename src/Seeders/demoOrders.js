// DEMONSTRATION orders, quotes, jobs and tickets created through the real services, so
// every state a dashboard can show has an example. Runs after demoData.js.
const fs = require("fs");
const path = require("path");
const { sequelize, User, Product, ArtworkAsset, Order, OrderItem, Commission, Vendor, Review, Address } = require("../Models");
const accessService = require("../Services/accessService");
const cartService = require("../Services/cartService");
const orderService = require("../Services/orderService");
const paymentService = require("../Services/paymentService");
const proofService = require("../Services/proofService");
const productionService = require("../Services/productionService");
const shipmentService = require("../Services/shipmentService");
const quoteService = require("../Services/quoteService");
const ticketService = require("../Services/ticketService");
const designService = require("../Services/designService");
const reviewService = require("../Services/reviewService");
const storage = require("../Services/storageService");
const { sha256 } = require("../Utils/crypto");

const MOCKUPS = path.resolve(__dirname, "../../../ui/public/demo/products");

async function ctx(email) {
  const user = await User.findOne({ where: { email } });
  return accessService.loadContext(user.id);
}

// Uses the product mock-up as the design preview so demo proofs look like the product.
async function mockupAsset(owner, file) {
  const full = path.join(MOCKUPS, file);
  const buffer = fs.existsSync(full) ? fs.readFileSync(full) : Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 10 10"><rect width="10" height="10" fill="#ddd"/></svg>');
  const key = await storage.put(buffer, "svg");
  return ArtworkAsset.create({ owner_user_id: owner.user.id, kind: "preview", original_name: file, storage_key: key, mime_type: "image/svg+xml", size_bytes: buffer.length, checksum: sha256(buffer), scan_status: "clean" });
}

async function product(slug) {
  return Product.findOne({ where: { slug }, include: ["variants", "methods"] });
}

async function design(owner, slug, color, text) {
  const p = await product(slug);
  const variant = p.variants.find((v) => v.attributes.color === color) || p.variants[0];
  const preview = await mockupAsset(owner, path.basename(variant.image));
  const area = (await p.getPrintAreas())[0];
  const saved = await designService.saveVersion(owner, {
    productId: p.id,
    variantId: variant.id,
    methodId: p.methods.find((m) => m.is_default)?.method_id,
    name: `${p.name} - ${text}`,
    previewAssetId: preview.id,
    canvas: { areas: { [area.code]: { layers: [{ type: "text", id: "t1", text, font: "Poppins", color: "#c62828", size: 0.18, x: 0.05, y: 0.4, rotation: 0 }] } } },
  });
  return { product: p, variant, versionId: saved.version.id };
}

async function order(owner, lines, { pay = true, poNumber, addressFilter } = {}) {
  for (const line of lines) await cartService.addItem(owner, line);
  const addresses = await Address.findAll({ where: addressFilter || { user_id: owner.user.id } });
  const address = addresses[0] || (await Address.findOne({ where: { company_id: owner.companyId } }));
  const { order: created } = await orderService.checkout(owner, { addressId: address.id, idempotencyKey: `demo-${Date.now()}-${Math.random()}`, poNumber });
  if (pay && created.actions.canPay) {
    const intent = await paymentService.createIntent(owner, created.id);
    await paymentService.completeMock(owner, intent.paymentId, "success");
  }
  await Order.update({ is_demo: true }, { where: { id: created.id } });
  return orderService.detail(owner, created.id);
}

async function runJob(staff, jobId, until) {
  const steps = ["in_production", "quality_check"];
  for (const status of steps) {
    await productionService.updateMilestone(staff, jobId, { status, note: status === "in_production" ? "Started" : "Ready for QC" });
    if (until === status) return;
  }
  await productionService.recordQc(staff, jobId, { result: "pass", checklist: { placement: true, colour: true, spelling: true } });
}

async function seedDemoOrders() {
  if (process.env.APP_ENV === "production") return;
  const existing = await Order.count({ where: { is_demo: true } });
  if (existing) {
    console.log("Demo orders already present");
    return;
  }
  const priya = await ctx("priya@demo.test");
  const anjali = await ctx("anjali@acme.test");
  const rahul = await ctx("rahul@acme.test");
  const vikram = await ctx("vikram@globex.test");
  const admin = await ctx("admin@demo.test");
  const ravi = await ctx("ravi@stitchline.test");
  const arjun = await ctx("arjun@craftwood.test");
  const stitchline = await Vendor.findOne({ where: { business_name: "Stitchline Embroidery Works" } });
  const craftwood = await Vendor.findOne({ where: { business_name: "Craftwood Gifts" } });

  // 1. Priya: delivered photo mug (in-house), with a review.
  const mug = await design(priya, "classic-ceramic-coffee-mug", "White", "Happy Birthday Ravi");
  const o1 = await order(priya, [{ productId: mug.product.id, variantId: mug.variant.id, quantity: 2, designVersionId: mug.versionId }]);
  await proofService.approve(priya, o1.items[0].proofs[0].id, { comment: "Perfect" });
  const job1 = await productionService.assign(admin, { orderItemId: o1.items[0].id, source: "in_house", machine: "Sublimation press 1" });
  await runJob(admin, job1.id);
  const s1 = await shipmentService.createShipment(admin, { jobIds: [job1.id], carrier: "Delhivery", trackingNumber: `DLV${Date.now()}` });
  await shipmentService.addTracking(admin, s1.id, { status: "in_transit", location: "Bhiwandi hub" });
  await shipmentService.addTracking(admin, s1.id, { status: "delivered", location: "Mumbai" });
  await sequelize.query(`UPDATE order_items SET delivered_at = now() - interval '2 days' WHERE id = :id`, { replacements: { id: o1.items[0].id } });
  await reviewService.create(priya, { productId: mug.product.id, rating: 5, title: "Lovely print quality", body: "The colours came out exactly like the preview. Delivered on time." });
  const review = await Review.findOne({ where: { user_id: priya.user.id } });
  await reviewService.moderate(review.id, "approved");

  // 2. Priya: T-shirt waiting for her proof approval.
  const tee = await design(priya, "classic-cotton-round-neck-t-shirt", "Black", "Team Priya");
  await order(priya, [{ productId: tee.product.id, variantId: tee.variant.id, quantity: 3, designVersionId: tee.versionId }]);

  // 3. Priya: frame awaiting payment.
  const frame = await design(priya, "wooden-photo-frame", "Walnut", "Our first home");
  await order(priya, [{ productId: frame.product.id, variantId: frame.variant.id, quantity: 1, designVersionId: frame.versionId }], { pay: false });

  // 4. Globex (credit account): embroidered polos assigned to Stitchline, in production.
  const polo = await design(vikram, "premium-pique-polo-t-shirt", "Navy", "GLOBEX");
  const o4 = await order(vikram, [{ productId: polo.product.id, variantId: polo.variant.id, quantity: 60, designVersionId: polo.versionId }], { poNumber: "GLX-2026-118", addressFilter: { company_id: vikram.companyId } });
  await proofService.approve(vikram, o4.items[0].proofs[0].id, {});
  const job4 = await productionService.assign(admin, { orderItemId: o4.items[0].id, source: "vendor", vendorId: stitchline.id, agreedCostPaise: 60 * 30000 });
  await productionService.respond(ravi, job4.id, { accept: true });
  await productionService.updateMilestone(ravi, job4.id, { status: "in_production", note: "Digitising approved, stitching started" });

  // 5. Globex: diaries ready to assign (no customisation).
  const diary = await product("executive-pu-leather-diary-a5");
  await order(vikram, [{ productId: diary.id, variantId: diary.variants[0].id, quantity: 25 }], { poNumber: "GLX-2026-121", addressFilter: { company_id: vikram.companyId } });

  // 6. Craftwood marketplace listing: delivered and past the complaint window, so it is settleable.
  const keychain = await product("engraved-walnut-keychain");
  const o6 = await order(priya, [{ productId: keychain.id, variantId: keychain.variants[0].id, quantity: 4 }]);
  const job6 = await productionService.assign(admin, { orderItemId: o6.items[0].id, source: "vendor", vendorId: craftwood.id });
  await productionService.respond(arjun, job6.id, { accept: true });
  await runJob(arjun, job6.id);
  const s6 = await shipmentService.createShipment(arjun, { jobIds: [job6.id], carrier: "India Post", trackingNumber: `EM${Date.now()}IN` });
  await shipmentService.addTracking(arjun, s6.id, { status: "delivered", location: "Mumbai" });
  await sequelize.query(`UPDATE order_items SET delivered_at = now() - interval '10 days' WHERE id = :id`, { replacements: { id: o6.items[0].id } });
  await orderService.closeDeliveredLines();
  await Commission.update({ eligible_at: new Date() }, { where: { order_item_id: o6.items[0].id } });

  // 7. Acme: quote request awaiting pricing, and a sent quote awaiting the customer.
  const hoodie = await product("fleece-pullover-hoodie");
  await quoteService.create(anjali, {
    title: "Annual offsite hoodies",
    deadline: new Date(Date.now() + 40 * 86400 * 1000).toISOString().slice(0, 10),
    budgetPaise: 30000000,
    deliveryLocations: "Bengaluru office",
    items: [{ productId: hoodie.id, variantId: hoodie.variants.find((v) => v.attributes.color === "Black").id, quantity: 350, sizeBreakdown: { S: 40, M: 120, L: 130, XL: 60 }, printAreaCount: 1 }],
    message: "We need the logo on the front and names on the back if possible.",
  });
  const kit = await product("new-joiner-welcome-kit");
  const q2 = await quoteService.create(anjali, {
    title: "Q4 welcome kits",
    deadline: new Date(Date.now() + 25 * 86400 * 1000).toISOString().slice(0, 10),
    items: [{ productId: kit.id, quantity: 120, printAreaCount: 1 }],
  });
  const suggestion = await quoteService.suggest(admin, q2.id);
  await quoteService.sendVersion(admin, q2.id, {
    productionDays: 12,
    paymentTerms: "advance_50",
    shippingPaise: 240000,
    packagingPaise: 0,
    discountPaise: 0,
    items: suggestion.map((s) => ({ requestItemId: s.requestItemId, productId: s.productId, variantId: s.variantId, methodId: s.methodId, description: s.description, quantity: s.quantity, unitPricePaise: s.unitPricePaise, setupFeePaise: s.setupFeePaise })),
    notes: "Includes branded sleeve and insert card.",
  });

  // 8. Acme: Rahul's order above the approval limit, waiting for Anjali.
  const bottle = await product("stainless-steel-water-bottle");
  const stocked = bottle.variants.reduce((a, b) => (b.stock_qty > a.stock_qty ? b : a));
  await order(rahul, [{ productId: bottle.id, variantId: stocked.id, quantity: 140 }], { pay: false, addressFilter: { company_id: rahul.companyId } });

  // 9. Support ticket on Priya's T-shirt order.
  const [teeOrder] = await Order.findAll({ where: { user_id: priya.user.id }, order: [["placed_at", "DESC"]], limit: 1, offset: 2 });
  const teeItem = await OrderItem.findOne({ where: { order_id: teeOrder.id } });
  await ticketService.create(priya, { orderId: teeOrder.id, orderItemId: teeItem.id, type: "change_request", subject: "Can the text be white instead of red?", message: "Please change the text colour to white before printing." });

  await Order.update({ is_demo: true }, { where: { user_id: [priya.user.id, anjali.user.id, rahul.user.id, vikram.user.id] } });
  console.log("Demo orders: 9 scenarios across B2C, B2B, marketplace, quotes and support");
}

module.exports = { seedDemoOrders };
