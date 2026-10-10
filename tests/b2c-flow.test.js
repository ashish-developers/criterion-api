// MVP acceptance criteria (Section 13.3), B2C path, end to end through the HTTP API.
const test = require("node:test");
const assert = require("node:assert/strict");
const { Client, shutdown, png, db } = require("./helpers");

test.after(shutdown);

const state = {};

test("a disallowed file type is rejected and a low-resolution upload triggers a warning", async () => {
  const priya = new Client();
  await priya.login("priya@demo.test");
  state.priya = priya;

  const exe = await priya.upload(Buffer.from("MZ\x90\x00 this is not an image"), "logo.png");
  assert.equal(exe.status, 422);
  assert.equal(exe.body.code, "FILE_TYPE_REJECTED");
  const svgScript = await priya.upload(Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>'), "x.svg");
  assert.equal(svgScript.status, 422);

  const product = await priya.get("/catalog/products/classic-ceramic-coffee-mug");
  state.mug = product.data;
  const front = state.mug.printAreas.find((a) => a.code === "front"); // 90 x 80 mm

  // 300 px over 90 mm ≈ 84 DPI: above the hard block (72) but below the 150 DPI recommendation.
  const low = await priya.upload(png(300, 300), "photo.png");
  assert.equal(low.status, 201);
  const tiny = await priya.upload(png(100, 100), "tiny.png");

  const blocked = await priya.post("/designs", {
    productId: state.mug.id,
    variantId: state.mug.variants[0].id,
    canvas: { areas: { front: { layers: [{ type: "image", id: "l1", assetId: tiny.data.id, x: 0, y: 0, width: 1, height: 1, rotation: 0 }] } } },
  });
  assert.equal(blocked.status, 422);
  assert.equal(blocked.body.code, "RESOLUTION_TOO_LOW");

  const preview = await priya.upload(png(600, 600), "preview.png", "?kind=preview");
  const saved = await priya.post("/designs", {
    productId: state.mug.id,
    variantId: state.mug.variants[0].id,
    methodId: state.mug.methods[0].id,
    name: "Birthday mug",
    previewAssetId: preview.data.id,
    canvas: {
      areas: {
        front: {
          layers: [
            { type: "image", id: "l1", assetId: low.data.id, x: 0, y: 0, width: 1, height: 1, rotation: 0 },
            { type: "text", id: "t1", text: "Happy Birthday Ravi", font: "Poppins", color: "#c62828", size: 0.12, x: 0.1, y: 0.8, rotation: 0 },
          ],
        },
      },
    },
  });
  assert.equal(saved.status, 201, JSON.stringify(saved.body));
  assert.equal(saved.data.version.warnings[0].type, "low_resolution");
  assert.ok(front.widthMm === 90);
  state.versionId = saved.data.version.id;
});

test("cart pricing is computed on the server and checkout is idempotent", async () => {
  const { priya } = state;
  const add = await priya.post("/cart/items", { productId: state.mug.id, variantId: state.mug.variants[0].id, quantity: 3, designVersionId: state.versionId, unitPricePaise: 1 });
  assert.equal(add.status, 201);
  assert.equal(add.data[0].unitPricePaise, 21600, "client-supplied prices are ignored");

  const addresses = await priya.get("/account/addresses");
  const cart = await priya.get(`/cart?addressId=${addresses.data[0].id}`);
  assert.equal(cart.data.totals.subtotalPaise, 64800);
  assert.ok(cart.data.totals.taxPaise > 0);

  const quoteOnly = await priya.post("/cart/items", { productId: state.mug.id, variantId: state.mug.variants[0].id, quantity: 600 });
  assert.equal(quoteOnly.status, 422);
  assert.equal(quoteOnly.body.code, "QUOTE_REQUIRED");

  const key = `test-${Date.now()}`;
  const order = await priya.post("/checkout", { addressId: addresses.data[0].id, idempotencyKey: key, couponCode: "WELCOME10" });
  assert.equal(order.status, 201, JSON.stringify(order.body));
  assert.equal(order.data.status, "payment_pending");
  assert.equal(order.data.discount_paise, 6480);
  const again = await priya.post("/checkout", { addressId: addresses.data[0].id, idempotencyKey: key });
  assert.equal(again.status, 200);
  assert.equal(again.data.id, order.data.id, "same idempotency key returns the same order");
  state.order = order.data;
});

test("payment is captured server-side exactly once and creates an automatic proof", async () => {
  const { priya } = state;
  const intent = await priya.post(`/orders/${state.order.id}/payments`);
  assert.equal(intent.status, 201);
  assert.equal(intent.data.amountPaise, state.order.total_paise);
  const paid = await priya.post(`/payments/${intent.data.paymentId}/mock-complete`, { outcome: "success" });
  assert.equal(paid.status, 200, JSON.stringify(paid.body));
  const twice = await priya.post(`/payments/${intent.data.paymentId}/mock-complete`, { outcome: "success" });
  assert.equal(twice.status, 200);
  const order = await priya.get(`/orders/${state.order.id}`);
  assert.equal(order.data.payment_status, "paid");
  assert.equal(order.data.amount_paid_paise, state.order.total_paise, "no double capture");
  assert.ok(order.data.invoice, "GST invoice issued for the paid order");
  const item = order.data.items[0];
  assert.equal(item.state, "proof_sent");
  assert.equal(item.proofs[0].versionNo, 1);
  state.proofId = item.proofs[0].id;
  state.itemId = item.id;

  const invoice = await priya.get(`/orders/${state.order.id}/invoice`);
  assert.equal(invoice.status, 200);
  assert.equal(invoice.data.is_interstate, false, "Mumbai to Maharashtra seller is intra-state");
  assert.ok(invoice.data.cgst_paise > 0 && invoice.data.sgst_paise > 0 && invoice.data.igst_paise === 0);
  assert.equal(invoice.data.lines[0].hsn, "6912");
});

test("approved proof is locked and the line becomes ready for production", async () => {
  const { priya } = state;
  const approve = await priya.post(`/proofs/${state.proofId}/approve`, { comment: "Looks great" });
  assert.equal(approve.status, 200, JSON.stringify(approve.body));
  assert.equal(approve.data.complete, true);
  const again = await priya.post(`/proofs/${state.proofId}/request-changes`, { comment: "Change colour" });
  assert.equal(again.status, 409, "an approved proof cannot be changed");
  const { Proof } = await db();
  const proof = await Proof.findByPk(state.proofId);
  assert.equal(proof.locked, true);
  await assert.rejects(() => proof.update({ notes: "tamper" }), /locked/, "database trigger blocks edits");
  const order = await priya.get(`/orders/${state.order.id}`);
  assert.equal(order.data.items[0].state, "proof_approved");
});

test("admin assigns the line to a vendor; the vendor accepts, produces, passes QC and dispatches", async () => {
  const admin = new Client();
  await admin.login("admin@demo.test");
  const sources = await admin.get(`/admin/order-items/${state.itemId}/sources`);
  assert.equal(sources.status, 200);
  assert.ok(sources.data.options.length > 0);

  const { Vendor } = await db();
  // Mugs are sublimation (in-house); demonstrate the vendor path by assigning to PrintPro? It is not approved.
  const pending = await Vendor.findOne({ where: { business_name: "PrintPro Solutions" } });
  const notApproved = await admin.post(`/admin/order-items/${state.itemId}/assign`, { source: "vendor", vendorId: pending.id });
  assert.equal(notApproved.status, 422, "unapproved vendors cannot receive jobs");

  const stitchline = await Vendor.findOne({ where: { business_name: "Stitchline Embroidery Works" } });
  const assigned = await admin.post(`/admin/order-items/${state.itemId}/assign`, { source: "vendor", vendorId: stitchline.id, agreedCostPaise: 18000 });
  assert.equal(assigned.status, 201, JSON.stringify(assigned.body));
  state.jobId = assigned.data.id;

  // Another vendor cannot see the job
  const other = new Client();
  await other.login("meena@bagcraft.test");
  assert.equal((await other.get(`/vendor/jobs/${state.jobId}`)).status, 404);

  const vendor = new Client();
  await vendor.login("ravi@stitchline.test");
  const job = await vendor.get(`/vendor/jobs/${state.jobId}`);
  assert.equal(job.status, 200);
  assert.ok(job.data.proof.locked, "vendor works from the locked proof");
  assert.equal(job.data.agreedCostPaise, 18000);
  assert.equal(job.data.item.shipTo.pincode, "400050");
  assert.ok(!JSON.stringify(job.data).includes("priya@demo.test"), "vendor does not see the customer's email");

  // Vendor can download the approved print file (proof preview) but not unrelated files
  const previewUrl = job.data.proof.previewUrl.replace("/api/v1", "");
  assert.equal((await vendor.get(previewUrl, { raw: true })).status, 200);
  assert.equal((await other.get(previewUrl, { raw: true })).status, 404);

  assert.equal((await vendor.post(`/vendor/jobs/${state.jobId}/respond`, { accept: true })).status, 200);
  assert.equal((await vendor.post(`/vendor/jobs/${state.jobId}/events`, { status: "in_production", note: "Printing" })).status, 200);
  const skip = await vendor.post(`/vendor/jobs/${state.jobId}/shipments`, { carrier: "Delhivery", trackingNumber: "DL123456" });
  assert.equal(skip.status, 409, "cannot dispatch before QC");
  assert.equal((await vendor.post(`/vendor/jobs/${state.jobId}/events`, { status: "quality_check" })).status, 200);
  const qcFail = await vendor.post(`/vendor/jobs/${state.jobId}/qc`, { result: "fail", defectQty: 1, notes: "Smudge" });
  assert.equal(qcFail.status, 201);
  let detail = await vendor.get(`/vendor/jobs/${state.jobId}`);
  assert.equal(detail.data.status, "in_production", "failed QC sends the job back for reprint");
  await vendor.post(`/vendor/jobs/${state.jobId}/events`, { status: "quality_check" });
  assert.equal((await vendor.post(`/vendor/jobs/${state.jobId}/qc`, { result: "pass", checklist: { placement: true, spelling: true } })).status, 201);
  const shipped = await vendor.post(`/vendor/jobs/${state.jobId}/shipments`, { carrier: "Delhivery", trackingNumber: `DL${Date.now()}` });
  assert.equal(shipped.status, 201, JSON.stringify(shipped.body));
  state.shipmentId = shipped.data.id;

  detail = await state.priya.get(`/orders/${state.order.id}`);
  assert.equal(detail.data.status, "shipped");
  assert.equal(detail.data.shipments[0].carrier, "Delhivery");
  state.vendor = vendor;
});

test("delivery is tracked and a defect complaint with photos creates a linked reprint", async () => {
  const delivered = await state.vendor.post(`/vendor/shipments/${state.shipmentId}/tracking`, { status: "delivered", location: "Mumbai" });
  assert.equal(delivered.status, 200, JSON.stringify(delivered.body));
  const order = await state.priya.get(`/orders/${state.order.id}`);
  assert.equal(order.data.status, "delivered");

  const noPhoto = await state.priya.post("/tickets", { orderId: state.order.id, orderItemId: state.itemId, type: "complaint", subject: "Print is smudged", message: "The print is smudged on one side." });
  assert.equal(noPhoto.status, 422, "complaints need photo evidence");
  const photo = await state.priya.upload(png(400, 400), "defect.png", "?kind=complaint_photo");
  const ticket = await state.priya.post("/tickets", { orderId: state.order.id, orderItemId: state.itemId, type: "complaint", subject: "Print is smudged", message: "The print is smudged on one side.", attachmentAssetIds: [photo.data.id] });
  assert.equal(ticket.status, 201, JSON.stringify(ticket.body));

  const support = new Client();
  await support.login("admin@demo.test");
  const resolved = await support.post(`/admin/tickets/${ticket.data.id}/resolve`, { decision: "reprint", liability: "vendor", note: "Vendor defect" });
  assert.equal(resolved.status, 200, JSON.stringify(resolved.body));
  assert.ok(resolved.data.reprintItemId);
  const after = await state.priya.get(`/orders/${state.order.id}`);
  const reprint = after.data.items.find((i) => i.id === resolved.data.reprintItemId);
  assert.equal(reprint.reprint_of_item_id, state.itemId, "reprint is linked to the original line");
  assert.equal(reprint.state, "proof_approved");
  assert.equal(reprint.approved_proof_id, after.data.items.find((i) => i.id === state.itemId).approved_proof_id, "reprint reuses the approved proof");
  const { Commission } = await db();
  const commission = await Commission.findOne({ where: { order_item_id: state.itemId } });
  assert.equal(commission.adjustment_paise, 18000, "vendor bears the reprint cost");
});

test("customers cannot cancel items in production and get a full refund before proof approval", async () => {
  const { priya } = state;
  const addresses = await priya.get("/account/addresses");
  const tee = (await priya.get("/catalog/products/classic-cotton-round-neck-t-shirt")).data;
  await priya.post("/cart/items", { productId: tee.id, variantId: tee.variants[0].id, quantity: 1 });
  const order = await priya.post("/checkout", { addressId: addresses.data[0].id, idempotencyKey: `cancel-${Date.now()}` });
  const intent = await priya.post(`/orders/${order.data.id}/payments`);
  await priya.post(`/payments/${intent.data.paymentId}/mock-complete`, { outcome: "success" });
  const cancel = await priya.post(`/orders/${order.data.id}/cancel`, { reason: "Ordered by mistake" });
  assert.equal(cancel.status, 200, JSON.stringify(cancel.body));
  assert.equal(cancel.data.chargesPaise, 0);
  assert.equal(cancel.data.refund.amountPaise, order.data.total_paise);
  const after = await priya.get(`/orders/${order.data.id}`);
  assert.equal(after.data.status, "cancelled");
  assert.equal(after.data.payment_status, "refunded");
});
