// Shipments and tracking (FR-VP-04, Section 8.6). Carrier details are entered by the
// producer today; a shipping-aggregator integration would call createShipment/addTracking
// from its label and webhook handlers.
const crypto = require("crypto");
const { Op } = require("sequelize");
const { sequelize, Shipment, ShipmentItem, TrackingEvent, OrderItem, Order, ProductionJob, JobEvent, Commission, Product, Vendor } = require("../Models");
const ApiError = require("../Utils/ApiError");
const { nextNumber } = require("../Utils/numbering");
const notificationService = require("./notificationService");

const orderService = () => require("./orderService");
const productionService = () => require("./productionService");

const TRACKING_FLOW = ["created", "picked_up", "in_transit", "out_for_delivery", "delivered"];

async function createShipment(auth, { jobIds = [], orderItemIds = [], carrier, trackingNumber, trackingUrl, weightGrams, recipientRef }) {
  return sequelize.transaction(async (transaction) => {
    const jobs = jobIds.length ? await ProductionJob.findAll({ where: { id: jobIds }, transaction, lock: transaction.LOCK.UPDATE }) : [];
    for (const job of jobs) {
      if (!productionService().canUpdate(auth, job) && !auth.permissions.has("shipping.manage")) throw ApiError.forbidden();
      if (job.status !== "ready_for_dispatch") throw ApiError.conflict(`Job ${job.job_number} has not passed quality check`, "NOT_READY_FOR_DISPATCH");
    }
    const ids = [...new Set([...orderItemIds, ...jobs.map((j) => j.order_item_id)])];
    if (!ids.length) throw ApiError.unprocessable("Choose what to ship", "NOTHING_TO_SHIP");
    if (!jobs.length && !auth.permissions.has("shipping.manage")) throw ApiError.forbidden();
    const items = await OrderItem.findAll({ where: { id: ids }, transaction, lock: transaction.LOCK.UPDATE });
    const orderIds = [...new Set(items.map((i) => i.order_id))];
    if (orderIds.length !== 1) throw ApiError.unprocessable("A shipment can contain lines from one order only", "MIXED_ORDERS");
    const order = await Order.findByPk(orderIds[0], { transaction, lock: transaction.LOCK.UPDATE });
    for (const item of items) {
      if (item.state !== "packed") throw ApiError.conflict(`${item.product_snapshot.name} is not packed yet`, "NOT_PACKED");
    }
    // B2B advance accounts pay the balance before dispatch (Section 7.5).
    if (order.payment_terms === "advance_50" && order.amount_paid_paise < order.total_paise) {
      throw ApiError.conflict("The balance payment must be received before dispatch", "BALANCE_DUE");
    }
    const vendorId = jobs.find((j) => j.vendor_id)?.vendor_id || null;
    let address = order.shipping_address;
    if (recipientRef) {
      const recipient = (order.recipients || []).find((r) => r.ref === recipientRef);
      if (!recipient) throw ApiError.unprocessable("Recipient not found on this order", "RECIPIENT_INVALID");
      address = { contact_name: recipient.name, phone: recipient.phone, line1: recipient.address, city: recipient.city, state: recipient.state, pincode: recipient.pincode, country: "India" };
    }
    const shipment = await Shipment.create(
      {
        shipment_number: await nextNumber("shipment", transaction),
        order_id: order.id,
        vendor_id: vendorId,
        shipped_by: auth.vendorId && vendorId === auth.vendorId ? "vendor" : "platform",
        carrier,
        tracking_number: trackingNumber,
        tracking_url: trackingUrl || null,
        status: "picked_up",
        address,
        weight_grams: weightGrams || null,
        dispatched_at: new Date(),
        created_by: auth.user.id,
        recipient_ref: recipientRef || null,
      },
      { transaction }
    );
    for (const item of items) {
      await ShipmentItem.create({ shipment_id: shipment.id, order_item_id: item.id, quantity: item.quantity }, { transaction });
      await orderService().transitionItem(item, "dispatched", { actorId: auth.user.id, note: `${carrier} ${trackingNumber}`, transaction, skipOrderRefresh: true });
    }
    for (const job of jobs) {
      await job.update({ status: "dispatched", dispatched_at: new Date() }, { transaction });
      await JobEvent.create({ job_id: job.id, event: "dispatched", status: "dispatched", note: `${carrier} ${trackingNumber}`, actor_user_id: auth.user.id }, { transaction });
    }
    await TrackingEvent.create({ shipment_id: shipment.id, status: "picked_up", description: `Handed over to ${carrier}`, occurred_at: new Date() }, { transaction });
    await orderService().refreshOrderStatus(order.id, transaction);
    await notificationService.notify(
      order.user_id,
      { type: "dispatched", title: `${order.order_number} has been dispatched`, body: `Shipped with ${carrier}, tracking number ${trackingNumber}.`, link: `/orders/${order.id}` },
      { transaction }
    );
    return shipment;
  });
}

// Commission / vendor earning recorded at delivery; payable after the complaint window.
async function recordCommission(item, transaction) {
  if (!item.vendor_id) return;
  const exists = await Commission.findOne({ where: { order_item_id: item.id }, transaction });
  if (exists) return;
  const product = await Product.findByPk(item.product_id, { transaction });
  const vendor = await Vendor.findByPk(item.vendor_id, { transaction });
  const job = await ProductionJob.findOne({ where: { order_item_id: item.id, vendor_id: item.vendor_id, status: { [Op.ne]: "rejected" } }, order: [["created_at", "DESC"]], transaction });
  // eligible_at is set when the line closes after the complaint window (orderService.closeDeliveredLines).
  if (product.source_type === "vendor_listing") {
    const value = item.taxable_paise;
    const commission = Math.round((value * Number(vendor.commission_pct)) / 100);
    await Commission.create(
      { order_item_id: item.id, vendor_id: vendor.id, model: "marketplace", item_value_paise: value, commission_pct: vendor.commission_pct, commission_paise: commission, vendor_earning_paise: value - commission, eligible_at: null },
      { transaction }
    );
  } else {
    // Fulfilment partner: paid the agreed job cost (falls back to the cost snapshot).
    const earning = job?.agreed_cost_paise || item.unit_cost_paise * item.quantity;
    await Commission.create(
      { order_item_id: item.id, vendor_id: vendor.id, model: "job_rate", item_value_paise: earning, commission_pct: 0, commission_paise: 0, vendor_earning_paise: earning, eligible_at: null },
      { transaction }
    );
  }
}

async function addTracking(auth, shipmentId, { status, location, description, occurredAt }) {
  return sequelize.transaction(async (transaction) => {
    const shipment = await Shipment.findByPk(shipmentId, { transaction, lock: transaction.LOCK.UPDATE });
    if (!shipment) throw ApiError.notFound("Shipment not found");
    const allowed = auth === "system" || auth.permissions.has("shipping.manage") || (shipment.vendor_id && auth.vendorId === shipment.vendor_id && auth.permissions.has("vendor.jobs.update"));
    if (!allowed) throw ApiError.forbidden();
    if (["delivered", "rto", "cancelled"].includes(shipment.status)) throw ApiError.conflict("This shipment is already closed", "SHIPMENT_CLOSED");
    if (status !== "rto" && TRACKING_FLOW.indexOf(status) < TRACKING_FLOW.indexOf(shipment.status)) {
      throw ApiError.conflict("Tracking cannot move backwards", "TRACKING_BACKWARDS");
    }
    await TrackingEvent.create({ shipment_id: shipment.id, status, location, description, occurred_at: occurredAt || new Date() }, { transaction });
    await shipment.update({ status, delivered_at: status === "delivered" ? new Date() : shipment.delivered_at }, { transaction });

    const actorId = auth === "system" ? null : auth.user.id;
    if (status === "delivered" || status === "rto") {
      const links = await ShipmentItem.findAll({ where: { shipment_id: shipment.id }, transaction });
      for (const link of links) {
        const item = await OrderItem.findByPk(link.order_item_id, { transaction, lock: transaction.LOCK.UPDATE });
        if (item.state !== "dispatched") continue;
        await orderService().transitionItem(item, status, { actorId, note: description || (status === "delivered" ? "Delivered" : "Returned to origin"), transaction, skipOrderRefresh: true });
        await ProductionJob.update({ status: "delivered" }, { where: { order_item_id: item.id, status: "dispatched" }, transaction });
        if (status === "delivered") await recordCommission(item, transaction);
      }
      await orderService().refreshOrderStatus(shipment.order_id, transaction);
      const order = await Order.findByPk(shipment.order_id, { transaction });
      await notificationService.notify(
        order.user_id,
        status === "delivered"
          ? { type: "delivered", title: `${order.order_number} delivered`, body: "Your order has been delivered. Report any problem within 7 days from the order page.", link: `/orders/${order.id}` }
          : { type: "rto", title: `${order.order_number} could not be delivered`, body: "The courier is returning the parcel. Our team will contact you.", link: `/orders/${order.id}` },
        { transaction }
      );
    }
    return shipment;
  });
}

// Generic tracking webhook for a shipping aggregator: HMAC-SHA256 of the raw body with
// SHIPPING_WEBHOOK_SECRET in X-Signature. Maps the aggregator's status to ours.
async function handleTrackingWebhook(req) {
  const secret = process.env.SHIPPING_WEBHOOK_SECRET;
  const signature = req.get("x-signature") || "";
  if (!secret || !req.rawBody) throw ApiError.unauthorized("Webhook not configured", "WEBHOOK_DISABLED");
  const expected = crypto.createHmac("sha256", secret).update(req.rawBody).digest("hex");
  if (expected.length !== signature.length || !crypto.timingSafeEqual(Buffer.from(expected), Buffer.from(signature))) {
    throw ApiError.unauthorized("Invalid webhook signature", "SIGNATURE_INVALID");
  }
  const { tracking_number: trackingNumber, carrier, status, location, description } = req.body || {};
  const shipment = await Shipment.findOne({ where: { tracking_number: trackingNumber, ...(carrier ? { carrier } : {}) } });
  if (!shipment) return { ignored: true };
  if (!TRACKING_FLOW.includes(status) && status !== "rto") return { ignored: true };
  if (shipment.status === status) return { duplicate: true };
  await addTracking("system", shipment.id, { status, location, description });
  return { processed: true };
}

async function list(auth, { status, page = 1, limit = 30 }) {
  const where = {};
  if (status) where.status = status;
  if (!auth.permissions.has("shipping.manage")) {
    if (!auth.vendorId) throw ApiError.forbidden();
    where.vendor_id = auth.vendorId;
  }
  const { rows, count } = await Shipment.findAndCountAll({
    where,
    include: [{ model: Order, as: "order", attributes: ["id", "order_number"] }, { model: TrackingEvent, as: "trackingEvents" }],
    order: [["created_at", "DESC"]],
    limit,
    offset: (page - 1) * limit,
    distinct: true,
  });
  return { items: rows, total: count };
}

module.exports = { createShipment, addTracking, handleTrackingWebhook, list, recordCommission, TRACKING_FLOW };
