// B2B quotation workflow, business approvals and role-based access control.
const test = require("node:test");
const assert = require("node:assert/strict");
const { Client, shutdown, png } = require("./helpers");

test.after(shutdown);
const state = {};

test("a business buyer requests a quote for 200 T-shirts with a size split, receives it, accepts it and pays 50% advance", async () => {
  const anjali = new Client();
  await anjali.login("anjali@acme.test");
  state.anjali = anjali;
  const tee = (await anjali.get("/catalog/products/classic-cotton-round-neck-t-shirt")).data;
  const logo = await anjali.upload(png(2400, 2400), "acme-logo.png");
  const screen = tee.methods.find((m) => m.code === "screen_print");

  const rfq = await anjali.post("/quotes", {
    title: "Acme onboarding tees",
    deadline: new Date(Date.now() + 30 * 86400 * 1000).toISOString().slice(0, 10),
    budgetPaise: 9000000,
    items: [{ productId: tee.id, variantId: tee.variants.find((v) => v.attributes.color === "Navy").id, methodId: screen.id, quantity: 200, sizeBreakdown: { S: 30, M: 70, L: 60, XL: 40 }, printAreaCount: 1, artworkAssetIds: [logo.data.id] }],
  });
  assert.equal(rfq.status, 201, JSON.stringify(rfq.body));
  state.quoteId = rfq.data.id;

  const rahul = new Client();
  await rahul.login("rahul@acme.test");
  assert.equal((await rahul.get(`/quotes/${state.quoteId}`)).status, 200, "company members see company quotes");
  const priya = new Client();
  await priya.login("priya@demo.test");
  assert.equal((await priya.get(`/quotes/${state.quoteId}`)).status, 404, "other customers do not");
  assert.equal((await anjali.post(`/quotes/${state.quoteId}/versions`, {})).status, 403, "customers cannot price quotes");

  const admin = new Client();
  await admin.login("admin@demo.test");
  state.admin = admin;
  const suggestion = await admin.get(`/quotes/${state.quoteId}/suggestion`);
  assert.equal(suggestion.status, 200);
  const line = suggestion.data[0];
  assert.equal(line.quantity, 200, "size breakdown total becomes the quantity");
  const sent = await admin.post(`/quotes/${state.quoteId}/versions`, {
    productionDays: 7,
    paymentTerms: "advance_50",
    shippingPaise: 150000,
    items: [{ requestItemId: line.requestItemId, productId: line.productId, variantId: line.variantId, methodId: line.methodId, description: line.description, quantity: 200, sizeBreakdown: line.sizeBreakdown, unitPricePaise: 29900, setupFeePaise: line.setupFeePaise }],
  });
  assert.equal(sent.status, 201, JSON.stringify(sent.body));

  const quote = await anjali.get(`/quotes/${state.quoteId}`);
  assert.equal(quote.data.status, "sent");
  assert.ok(quote.data.actions.canAccept);
  const addr = (await anjali.get("/account/addresses")).data.find((a) => a.company_id);
  const accepted = await anjali.post(`/quotes/${state.quoteId}/accept`, { addressId: addr.id, poNumber: "PO-ACME-7781" });
  assert.equal(accepted.status, 200, JSON.stringify(accepted.body));
  state.orderId = accepted.data.orderId;

  const order = await anjali.get(`/orders/${state.orderId}`);
  assert.equal(order.data.payment_terms, "advance_50");
  assert.equal(order.data.subtotal_paise, 29900 * 200, "quoted prices are kept");
  assert.equal(order.data.po_number, "PO-ACME-7781");
  assert.equal(order.data.amountDue.purpose, "advance");
  assert.equal(order.data.amountDue.amountPaise, Math.ceil(order.data.total_paise / 2));
  assert.ok(order.data.igst_paise > 0, "Karnataka buyer, Maharashtra seller: IGST");

  const intent = await anjali.post(`/orders/${state.orderId}/payments`);
  assert.equal(intent.data.amountPaise, Math.ceil(order.data.total_paise / 2));
  await anjali.post(`/payments/${intent.data.paymentId}/mock-complete`, { outcome: "success" });
  const paid = await anjali.get(`/orders/${state.orderId}`);
  assert.equal(paid.data.payment_status, "partially_paid");
  assert.equal(paid.data.items[0].state, "artwork_pending", "advance unlocks the artwork and proof stage");
  assert.equal((await anjali.post(`/quotes/${state.quoteId}/accept`, { addressId: addr.id })).status, 409, "a converted quote cannot be accepted twice");
});

test("designer proof, approval and the balance-before-dispatch rule", async () => {
  const { admin, anjali } = state;
  const order = await admin.get(`/admin/orders/${state.orderId}`);
  const item = order.data.items[0];
  const proofImage = await admin.upload(png(800, 800), "proof.png", "?kind=proof");
  const proof = await admin.post("/admin/proofs", { orderItemId: item.id, previewAssetId: proofImage.data.id, notes: "Navy tee, white logo, left chest 90 mm" });
  assert.equal(proof.status, 201, JSON.stringify(proof.body));
  const rahul = new Client();
  await rahul.login("rahul@acme.test");
  assert.equal((await rahul.post(`/proofs/${proof.data.id}/approve`, {})).status, 404, "buyers without approval rights cannot approve company proofs");
  const approved = await anjali.post(`/proofs/${proof.data.id}/approve`, {});
  assert.equal(approved.status, 200, JSON.stringify(approved.body));

  const assign = await admin.post(`/admin/order-items/${item.id}/assign`, { source: "in_house" });
  assert.equal(assign.status, 201, JSON.stringify(assign.body));
  const jobId = assign.data.id;
  const prod = new Client();
  await prod.login("production@demo.test");
  await prod.post(`/admin/production/jobs/${jobId}/events`, { status: "in_production" });
  await prod.post(`/admin/production/jobs/${jobId}/events`, { status: "quality_check" });
  const noPhotos = await prod.post(`/admin/production/jobs/${jobId}/qc`, { result: "pass" });
  assert.equal(noPhotos.status, 422, "QC photos required for B2B orders over 50 units");
  const qcPhoto = await prod.upload(png(500, 500), "qc.png", "?kind=qc_photo");
  assert.equal((await prod.post(`/admin/production/jobs/${jobId}/qc`, { result: "pass", photoAssetIds: [qcPhoto.data.id] })).status, 201);

  const blocked = await prod.post("/admin/shipments", { jobIds: [jobId], carrier: "Blue Dart", trackingNumber: `BD${Date.now()}` });
  assert.equal(blocked.status, 409);
  assert.equal(blocked.body.code, "BALANCE_DUE");
  const balance = await anjali.post(`/orders/${state.orderId}/payments`);
  assert.equal(balance.data.purpose, "balance");
  await anjali.post(`/payments/${balance.data.paymentId}/mock-complete`, { outcome: "success" });
  const shipped = await prod.post("/admin/shipments", { jobIds: [jobId], carrier: "Blue Dart", trackingNumber: `BD${Date.now()}` });
  assert.equal(shipped.status, 201, JSON.stringify(shipped.body));

  // Production staff see specifications but no pricing
  const prodView = await prod.get(`/admin/orders/${state.orderId}`);
  assert.equal(prodView.data.total_paise, undefined);
  assert.equal(prodView.data.items[0].unit_price_paise, undefined);
  assert.equal((await prod.get("/admin/payments")).status, 403);
});

test("orders above the company approval limit wait for an approver", async () => {
  const rahul = new Client();
  await rahul.login("rahul@acme.test");
  const bottle = (await rahul.get("/catalog/products/stainless-steel-water-bottle")).data;
  const variant = bottle.variants.reduce((a, b) => (b.stockQty > a.stockQty ? b : a));
  assert.ok(variant.stockQty >= 150, "demo stock supports the test");
  // 150 bottles is above Acme's ₹50,000 approval limit.
  const add = await rahul.post("/cart/items", { productId: bottle.id, variantId: variant.id, quantity: 150 });
  assert.equal(add.status, 201, JSON.stringify(add.body));
  const addr = (await rahul.get("/account/addresses")).data.find((a) => a.company_id);
  const order = await rahul.post("/checkout", { addressId: addr.id, idempotencyKey: `appr-${Date.now()}` });
  assert.equal(order.status, 201, JSON.stringify(order.body));
  assert.equal(order.data.status, "awaiting_approval");
  assert.equal((await rahul.post(`/orders/${order.data.id}/payments`)).status, 409, "cannot pay before approval");
  assert.equal((await rahul.post(`/business/approvals/${order.data.id}`, { approve: true })).status, 403, "buyers cannot approve");
  const approve = await state.anjali.post(`/business/approvals/${order.data.id}`, { approve: true, comment: "OK for onboarding" });
  assert.equal(approve.status, 200, JSON.stringify(approve.body));
  const after = await rahul.get(`/orders/${order.data.id}`);
  assert.equal(after.data.approval_status, "approved");
  assert.ok(after.data.actions.canPay);
});

test("approved credit accounts get PO terms without upfront payment", async () => {
  const vikram = new Client();
  await vikram.login("vikram@globex.test");
  const diary = (await vikram.get("/catalog/products/executive-pu-leather-diary-a5")).data;
  await vikram.post("/cart/items", { productId: diary.id, variantId: diary.variants[0].id, quantity: 20 });
  const addr = (await vikram.get("/account/addresses")).data.find((a) => a.company_id);
  const order = await vikram.post("/checkout", { addressId: addr.id, poNumber: "GLX-4410", idempotencyKey: `credit-${Date.now()}` });
  assert.equal(order.status, 201, JSON.stringify(order.body));
  assert.equal(order.data.payment_terms, "credit_30");
  assert.equal(order.data.payment_status, "credit");
  assert.ok(order.data.invoice?.dueDate, "credit invoice has a due date");
  assert.equal(order.data.items[0].state, "proof_approved", "plain items are ready for production immediately");
});

test("role boundaries are enforced by the API, not just the UI", async () => {
  const priya = new Client();
  await priya.login("priya@demo.test");
  for (const path of ["/admin/dashboard", "/admin/orders", "/admin/users", "/business/dashboard", "/vendor/dashboard", "/admin/audit-logs"]) {
    const res = await priya.get(path);
    assert.ok([401, 403].includes(res.status), `${path} -> ${res.status}`);
  }
  // Another customer's order is invisible (404, not 403, to avoid confirming it exists).
  assert.equal((await priya.get(`/orders/${state.orderId}`)).status, 404);
  // Support agents can view orders but cannot change settings or roles.
  const support = new Client();
  await support.login("support@demo.test");
  assert.equal((await support.get("/admin/orders")).status, 200);
  assert.equal((await support.get("/admin/settings")).status, 403);
  assert.equal((await support.put("/admin/roles/1/permissions", { permissions: [] })).status, 403);
  // A pending vendor cannot use the portal yet.
  const kiran = new Client();
  await kiran.login("kiran@printpro.test");
  const blocked = await kiran.get("/vendor/jobs");
  assert.equal(blocked.status, 403);
  assert.equal(blocked.body.code, "VENDOR_NOT_APPROVED");
  // Payload tampering: a customer cannot put a price on a cart line or set a status.
  const tee = (await priya.get("/catalog/products/classic-cotton-round-neck-t-shirt")).data;
  const add = await priya.post("/cart/items", { productId: tee.id, variantId: tee.variants[0].id, quantity: 1, unitPricePaise: 1, status: "paid" });
  assert.notEqual(add.data[0].unitPricePaise, 1);
  // Admin actions are audit-logged.
  const admin = new Client();
  await admin.login("admin@demo.test");
  const logs = await admin.get("/admin/audit-logs");
  assert.ok(logs.data.some((l) => l.action === "order_item.assigned"));
});

test("vendor onboarding: application with KYC, admin approval, then portal access", async () => {
  const c = new Client();
  await c.csrf();
  const email = `vendor${Date.now()}@example.com`;
  const reg = await c.post("/auth/register", { name: "New Vendor", email, phone: "9812345678", password: "Vendor123", confirmPassword: "Vendor123", accountType: "vendor", acceptTerms: true });
  const verified = await c.post("/auth/verify-otp", { challengeId: reg.data.challengeId, otp: reg.data.devOtp });
  assert.equal(verified.data.homePath, "/vendor/onboarding");
  const app = await c.post("/vendor/application", {
    businessName: "Quick Prints",
    legalName: "Quick Prints LLP",
    vendorType: "fulfilment_partner",
    gstin: "27ABCDE1234F1Z5",
    pan: "ABCDE1234F",
    bankAccountName: "Quick Prints LLP",
    bankAccountNumber: "123456789012",
    bankIfsc: "ICIC0001234",
    contactEmail: email,
    contactPhone: "9812345678",
    address: { line1: "Lower Parel", city: "Mumbai", state: "Maharashtra", pincode: "400013" },
    dailyCapacity: 300,
    capabilities: [{ methodCode: "dtf", minQty: 1, maxQty: 500, dailyCapacity: 300, leadTimeDays: 3 }],
  });
  assert.equal(app.status, 201, JSON.stringify(app.body));
  assert.equal(app.data.bank_account_last4, "9012");
  assert.ok(!JSON.stringify(app.body).includes("123456789012"), "full bank account number is never returned");
  assert.equal((await c.get("/vendor/jobs")).status, 403);
  const admin = new Client();
  await admin.login("admin@demo.test");
  const decision = await admin.post(`/admin/vendors/${app.data.id}/decision`, { status: "approved" });
  assert.equal(decision.status, 200, JSON.stringify(decision.body));
  assert.equal((await c.get("/vendor/jobs")).status, 200);
});
