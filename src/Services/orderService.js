// Orders: checkout, line-state transitions (Section 7.1), cancellations (7.6), approvals
// for business spend limits (FR-BB-05), reorder, and order views scoped by role.
const { Op } = require("sequelize");
const {
  sequelize,
  Order,
  OrderItem,
  OrderEvent,
  Address,
  Company,
  CompanyMember,
  Cart,
  CartItem,
  CouponRedemption,
  Coupon,
  ProductVariant,
  InventoryMovement,
  Proof,
  Payment,
  Shipment,
  ShipmentItem,
  TrackingEvent,
  Invoice,
  Refund,
  Product,
  DesignVersion,
  ProductionJob,
  Ticket,
  User,
  Commission,
} = require("../Models");
const ApiError = require("../Utils/ApiError");
const { nextNumber } = require("../Utils/numbering");
const machine = require("./orderStateMachine");
const cartService = require("./cartService");
const totalsService = require("./totalsService");
const settingsService = require("./settingsService");
const notificationService = require("./notificationService");
const shippingEstimator = require("./shippingEstimator");

// ------------------------------------------------------------------ helpers
function addressSnapshot(a) {
  return {
    contact_name: a.contact_name,
    phone: a.phone,
    line1: a.line1,
    line2: a.line2,
    city: a.city,
    state: a.state,
    pincode: a.pincode,
    country: a.country || "India",
  };
}

async function event(orderId, itemId, name, { from, to, note, actorId, visible = true, transaction } = {}) {
  return OrderEvent.create(
    { order_id: orderId, order_item_id: itemId, event: name, from_state: from, to_state: to, note, actor_user_id: actorId || null, is_customer_visible: visible },
    { transaction }
  );
}

async function refreshOrderStatus(orderId, transaction) {
  const order = await Order.findByPk(orderId, { transaction, lock: transaction.LOCK.UPDATE });
  const items = await OrderItem.findAll({ where: { order_id: orderId }, transaction });
  const status = machine.deriveOrderStatus(items.map((i) => i.state), {
    approvalPending: order.approval_status === "pending",
    paymentPending: !paymentConditionMet(order),
  });
  const patch = { status };
  if (status === "delivered" && !order.delivered_at) patch.delivered_at = new Date();
  if (status === "completed" && !order.closed_at) patch.closed_at = new Date();
  if (status !== order.status) await order.update(patch, { transaction });
  return order;
}

/** Move one order line to a new state, enforcing the state model and logging the timeline. */
async function transitionItem(item, to, { actorId, note, transaction, visible = true, skipOrderRefresh = false } = {}) {
  machine.assertTransition(item.state, to, item.previous_state);
  const from = item.state;
  const patch = { state: to };
  if (to === "on_hold") patch.previous_state = from;
  if (from === "on_hold") patch.previous_state = null;
  if (to === "delivered") patch.delivered_at = new Date();
  await item.update(patch, { transaction });
  await event(item.order_id, item.id, "state_changed", { from, to, note, actorId, visible, transaction });
  if (!skipOrderRefresh) await refreshOrderStatus(item.order_id, transaction);
  return item;
}

// Amount the customer has to pay now under the order's payment terms (Section 7.5).
async function amountDue(order) {
  const outstanding = order.total_paise - order.amount_paid_paise;
  if (outstanding <= 0) return { amountPaise: 0, purpose: null };
  if (["credit_15", "credit_30"].includes(order.payment_terms)) return { amountPaise: outstanding, purpose: "balance", optional: true };
  if (order.payment_terms === "advance_50" && order.amount_paid_paise === 0) {
    const { b2b_advance_pct: pct } = await settingsService.get("orders");
    return { amountPaise: Math.ceil((order.total_paise * pct) / 100), purpose: "advance" };
  }
  return { amountPaise: outstanding, purpose: order.amount_paid_paise > 0 ? "balance" : "full" };
}

// Has the order met its payment condition for production to start?
function paymentConditionMet(order) {
  if (["credit_15", "credit_30"].includes(order.payment_terms)) return true;
  if (order.payment_terms === "advance_50") return order.amount_paid_paise > 0;
  return order.amount_paid_paise >= order.total_paise;
}

/**
 * Called when payment (or approval for credit accounts) unlocks production:
 * lines move to artwork pending, and lines with a saved design get an automatic proof.
 */
async function advanceAfterPayment(orderId, { actorId, transaction }) {
  const proofService = require("./proofService");
  const order = await Order.findByPk(orderId, { transaction });
  if (order.approval_status === "pending" || !paymentConditionMet(order)) return;
  const items = await OrderItem.findAll({ where: { order_id: orderId, state: { [Op.in]: ["placed", "payment_pending"] } }, transaction });
  for (const item of items) {
    if (item.requires_proof) {
      await transitionItem(item, "artwork_pending", { actorId, transaction, skipOrderRefresh: true, note: "Payment confirmed" });
      if (item.design_version_id) await proofService.autoCreate(item, { transaction });
    } else {
      await transitionItem(item, "proof_approved", { actorId, transaction, skipOrderRefresh: true, note: "No customisation - ready for production" });
      const product = await Product.findByPk(item.product_id, { transaction });
      await item.update({ due_date: shippingEstimator.toDateOnly(shippingEstimator.addWorkingDays(new Date(), product.lead_time_days)) }, { transaction });
    }
  }
  if (["credit_15", "credit_30"].includes(order.payment_terms) && order.payment_status === "pending") {
    await order.update({ payment_status: "credit" }, { transaction });
    await require("./invoiceService").generate(order.id, { transaction });
  }
  await refreshOrderStatus(orderId, transaction);
}

async function adjustStock(items, direction, { actorId, reason, transaction, orderId }) {
  for (const item of items) {
    const variant = await ProductVariant.findByPk(item.variant_id, { transaction, lock: transaction.LOCK.UPDATE });
    if (!variant || !variant.track_inventory) continue;
    const change = direction * item.quantity;
    if (direction < 0 && variant.stock_qty < item.quantity) {
      throw ApiError.conflict(`Only ${variant.stock_qty} left in stock for ${variant.sku}`, "OUT_OF_STOCK");
    }
    await variant.update({ stock_qty: variant.stock_qty + change }, { transaction });
    await InventoryMovement.create(
      { variant_id: variant.id, change_qty: change, balance_after: variant.stock_qty, reason, reference_type: "order", reference_id: orderId, created_by: actorId },
      { transaction }
    );
  }
}

async function companyContext(auth, transaction) {
  if (!auth.companyId) return { company: null, needsApproval: () => false };
  const company = await Company.findByPk(auth.companyId, { transaction });
  return {
    company,
    needsApproval: (total) => company.approval_limit_paise > 0 && total > company.approval_limit_paise && !auth.permissions.has("company.orders.approve"),
  };
}

function paymentTermsFor(company, totalPaise) {
  if (!company) return "prepaid";
  if (["credit_15", "credit_30"].includes(company.payment_terms)) {
    // Credit only for approved accounts and within the credit limit; otherwise fall back to advance.
    if (company.credit_approved && (company.credit_limit_paise === 0 || totalPaise <= company.credit_limit_paise)) return company.payment_terms;
    return "advance_50";
  }
  return company.payment_terms;
}

async function ownedAddress(auth, id, transaction) {
  const address = await Address.findByPk(id, { transaction });
  const owns = address && (address.user_id === auth.user.id || (auth.companyId && address.company_id === auth.companyId));
  if (!owns) throw ApiError.unprocessable("Choose a delivery address", "ADDRESS_INVALID");
  return address;
}

// ------------------------------------------------------------------ checkout
async function checkout(auth, input) {
  // Idempotency: the same key from the same user returns the original order.
  if (input.idempotencyKey) {
    const existing = await Order.findOne({ where: { user_id: auth.user.id, idempotency_key: input.idempotencyKey } });
    if (existing) return { order: await detail(auth, existing.id), duplicate: true };
  }
  let orderId;
  try {
    orderId = await sequelize.transaction(async (transaction) => {
      const cart = await Cart.findOne({ where: { user_id: auth.user.id }, transaction, lock: transaction.LOCK.UPDATE });
      const cartItems = cart ? await CartItem.findAll({ where: { cart_id: cart.id }, order: [["created_at", "ASC"]], transaction }) : [];
      if (!cartItems.length) throw ApiError.unprocessable("Your cart is empty", "CART_EMPTY");

      const priced = await cartService.priceItems(cartItems, { transaction });
      const invalid = priced.find((l) => l.error);
      if (invalid) throw ApiError.unprocessable(`${invalid.productName}: ${invalid.error.message}`, invalid.error.code);

      const shipping = await ownedAddress(auth, input.addressId, transaction);
      const billing = input.billingAddressId ? await ownedAddress(auth, input.billingAddressId, transaction) : shipping;
      const { company, needsApproval } = await companyContext(auth, transaction);

      const subtotal = priced.reduce((s, l) => s + l.lineSubtotalPaise, 0);
      const couponCode = input.couponCode !== undefined ? input.couponCode : cart.coupon_code;
      const coupon = couponCode
        ? await totalsService.validateCoupon(couponCode, { userId: auth.user.id, isB2B: Boolean(company), subtotalPaise: subtotal, transaction })
        : null;
      const totals = await totalsService.compute(priced, { coupon, address: shipping });
      if (!totals.shipping.serviceable) throw ApiError.unprocessable(totals.shipping.reason || "We cannot deliver to this PIN code yet", "NOT_SERVICEABLE");
      if (input.deliverBy && totals.shipping.estimatedDelivery && input.deliverBy < totals.shipping.estimatedDelivery) {
        throw ApiError.unprocessable(
          `The earliest delivery for this cart is ${totals.shipping.estimatedDelivery}. Choose a later date or express production.`,
          "DELIVERY_DATE_UNACHIEVABLE",
          { earliest: totals.shipping.estimatedDelivery }
        );
      }

      const approvalPending = needsApproval(totals.totalPaise);
      const terms = paymentTermsFor(company, totals.totalPaise);
      const order = await Order.create(
        {
          order_number: await nextNumber("order", transaction),
          user_id: auth.user.id,
          company_id: company ? company.id : null,
          channel: company ? "b2b" : "b2c",
          status: approvalPending ? "awaiting_approval" : "payment_pending",
          payment_status: "pending",
          payment_terms: terms,
          approval_status: approvalPending ? "pending" : "not_required",
          subtotal_paise: totals.subtotalPaise,
          setup_fees_paise: totals.setupFeesPaise,
          discount_paise: totals.discountPaise,
          shipping_paise: totals.shippingPaise,
          tax_paise: totals.taxPaise,
          cgst_paise: totals.cgstPaise,
          sgst_paise: totals.sgstPaise,
          igst_paise: totals.igstPaise,
          total_paise: totals.totalPaise,
          coupon_id: coupon ? coupon.id : null,
          coupon_code: coupon ? coupon.code : null,
          shipping_address: addressSnapshot(shipping),
          billing_address: addressSnapshot(billing),
          gstin: input.gstin || company?.gstin || null,
          po_number: input.poNumber || null,
          gift_options: input.giftOptions || {},
          deliver_by: input.deliverBy || null,
          estimated_delivery: totals.shipping.estimatedDelivery || null,
          notes: input.notes || null,
          idempotency_key: input.idempotencyKey || null,
        },
        { transaction }
      );

      let lineNo = 0;
      for (const line of totals.lines) {
        await OrderItem.create(
          {
            order_id: order.id,
            line_no: ++lineNo,
            product_id: line.productId,
            variant_id: line.variantId,
            method_id: line.methodId,
            design_version_id: line.designVersionId,
            product_snapshot: {
              name: line.productName,
              slug: line.productSlug,
              sku: line.sku,
              attributes: line.attributes,
              image: line.image,
              method: line.methodName,
              artworkAssetIds: line.options?.artworkAssetIds || [],
              artworkNotes: line.options?.artworkNotes || null,
            },
            quantity: line.quantity,
            size_breakdown: line.sizeBreakdown,
            print_area_count: line.printAreaCount,
            express: line.express,
            unit_price_paise: line.unitPricePaise,
            setup_fee_paise: line.setupFeePaise,
            line_subtotal_paise: line.lineSubtotalPaise,
            discount_paise: line.discountPaise,
            taxable_paise: line.taxablePaise,
            hsn_code: line.hsnCode,
            gst_rate: line.gstRate,
            tax_paise: line.taxPaise,
            line_total_paise: line.lineTotalPaise,
            unit_cost_paise: line.unitCostPaise,
            requires_proof: line.requiresProof,
            state: approvalPending ? "placed" : "payment_pending",
          },
          { transaction }
        );
      }
      // Reserve stock for the blanks.
      await adjustStock(totals.lines.map((l) => ({ variant_id: l.variantId, quantity: l.quantity })), -1, {
        actorId: auth.user.id,
        reason: "order",
        transaction,
        orderId: order.id,
      });
      if (coupon) {
        await CouponRedemption.create({ coupon_id: coupon.id, user_id: auth.user.id, order_id: order.id, amount_paise: totals.discountPaise }, { transaction });
        await coupon.increment("used_count", { transaction });
      }
      await event(order.id, null, "order_placed", { actorId: auth.user.id, note: `Order placed (${order.payment_terms.replace("_", " ")})`, transaction });
      if (approvalPending) {
        await event(order.id, null, "approval_requested", { actorId: auth.user.id, note: "Order exceeds the company approval limit", transaction });
        await notifyApprovers(order, transaction);
      }
      await cartService.clear(auth.user.id, transaction);
      // Credit accounts proceed without upfront payment once approved.
      if (!approvalPending) await advanceAfterPayment(order.id, { actorId: auth.user.id, transaction });
      await notificationService.notify(
        auth.user.id,
        { type: "order_placed", title: `Order ${order.order_number} placed`, body: approvalPending ? "Your order is waiting for approval from your company approver." : "Thank you! Complete payment to start production.", link: `/orders/${order.id}` },
        { transaction }
      );
      return order.id;
    });
  } catch (error) {
    // A concurrent request with the same idempotency key won the race: return its order.
    if (error.name === "SequelizeUniqueConstraintError" && input.idempotencyKey) {
      const existing = await Order.findOne({ where: { user_id: auth.user.id, idempotency_key: input.idempotencyKey } });
      if (existing) return { order: await detail(auth, existing.id), duplicate: true };
    }
    throw error;
  }
  return { order: await detail(auth, orderId), duplicate: false };
}

async function notifyApprovers(order, transaction) {
  const approvers = await CompanyMember.findAll({ where: { company_id: order.company_id, member_role: { [Op.in]: ["admin", "approver"] }, status: "active" }, transaction });
  for (const a of approvers) {
    if (a.user_id === order.user_id) continue;
    await notificationService.notify(
      a.user_id,
      { type: "approval_required", title: `Approval needed for ${order.order_number}`, body: `An order of ₹${(order.total_paise / 100).toFixed(2)} needs your approval.`, link: `/business/approvals` },
      { transaction }
    );
  }
}

// ------------------------------------------------------------------ access
async function loadVisible(auth, orderId, { transaction, lock = false } = {}) {
  const order = await Order.findByPk(orderId, { transaction, lock: lock ? transaction.LOCK.UPDATE : undefined });
  if (!order) throw ApiError.notFound("Order not found");
  const isOwner = order.user_id === auth.user.id;
  const isCompany = order.company_id && order.company_id === auth.companyId && auth.permissions.has("company.view");
  const isStaff = auth.permissions.has("orders.view") || auth.permissions.has("production.view");
  if (!isOwner && !isCompany && !isStaff) throw ApiError.notFound("Order not found");
  return order;
}

function canSeePricing(auth, order) {
  // Production staff see specs and quantities but no pricing or payment data (Section 4.3).
  if (order.user_id === auth.user.id) return true;
  if (order.company_id && order.company_id === auth.companyId) return true;
  return auth.permissions.has("orders.view");
}

async function detail(auth, orderId) {
  const order = await loadVisible(auth, orderId);
  const [items, events, payments, shipments, invoice, refunds, customer, tickets] = await Promise.all([
    OrderItem.findAll({ where: { order_id: order.id }, order: [["line_no", "ASC"]] }),
    OrderEvent.findAll({ where: { order_id: order.id }, order: [["created_at", "ASC"]], include: [{ model: User, as: "actor", attributes: ["id", "name"] }] }),
    Payment.findAll({ where: { order_id: order.id }, order: [["created_at", "ASC"]] }),
    Shipment.findAll({ where: { order_id: order.id }, include: [{ model: ShipmentItem, as: "items" }, { model: TrackingEvent, as: "trackingEvents" }], order: [["created_at", "ASC"]] }),
    Invoice.findOne({ where: { order_id: order.id }, attributes: ["id", "invoice_number", "issued_at", "due_date"] }),
    Refund.findAll({ where: { order_id: order.id }, order: [["created_at", "ASC"]] }),
    User.findByPk(order.user_id, { attributes: ["id", "name", "email", "phone"] }),
    Ticket.findAll({ where: { order_id: order.id }, attributes: ["id", "ticket_number", "type", "status", "subject", "created_at"] }),
  ]);
  const proofs = await Proof.findAll({ where: { order_item_id: items.map((i) => i.id) }, order: [["version_no", "DESC"]] });
  const versionIds = items.map((i) => i.design_version_id).filter(Boolean);
  const versions = versionIds.length ? await DesignVersion.findAll({ where: { id: versionIds }, attributes: ["id", "design_id"] }) : [];
  const designOf = new Map(versions.map((v) => [v.id, v.design_id]));
  const jobs = await ProductionJob.findAll({ where: { order_item_id: items.map((i) => i.id) }, order: [["created_at", "DESC"]] });
  const staff = auth.permissions.has("orders.view") || auth.permissions.has("production.view");
  const pricing = canSeePricing(auth, order);
  const due = await amountDue(order);
  const policy = {};
  for (const item of items) {
    policy[item.id] = machine.cancellationPolicy(item.state);
    if (!item.requires_proof && item.state === "proof_approved") policy[item.id] = { allowed: true, charges: false };
  }

  const strip = (obj, keys) => {
    if (pricing) return obj;
    const copy = { ...obj };
    for (const k of keys) delete copy[k];
    return copy;
  };
  const money = ["unit_price_paise", "setup_fee_paise", "line_subtotal_paise", "discount_paise", "taxable_paise", "tax_paise", "line_total_paise", "unit_cost_paise"];
  const orderJson = order.toJSON();
  delete orderJson.idempotency_key;

  return {
    ...strip(orderJson, ["subtotal_paise", "setup_fees_paise", "discount_paise", "shipping_paise", "tax_paise", "cgst_paise", "sgst_paise", "igst_paise", "total_paise", "amount_paid_paise", "amount_refunded_paise", "coupon_code"]),
    customer: staff || order.company_id === auth.companyId ? customer : undefined,
    items: items.map((i) => {
      const json = strip(i.toJSON(), money);
      if (!staff) delete json.unit_cost_paise;
      return {
        ...json,
        design_id: designOf.get(i.design_version_id) || null,
        proofs: proofs.filter((p) => p.order_item_id === i.id).map((p) => ({
          id: p.id,
          versionNo: p.version_no,
          status: p.status,
          previewUrl: p.preview_asset_id ? `/api/v1/assets/${p.preview_asset_id}` : null,
          printFileUrl: p.print_file_asset_id ? `/api/v1/assets/${p.print_file_asset_id}` : null,
          notes: p.notes,
          isChargeable: p.is_chargeable,
          locked: p.locked,
          sentAt: p.sent_at,
          approvedAt: p.approved_at,
        })),
        jobs: staff ? jobs.filter((j) => j.order_item_id === i.id).map((j) => ({ id: j.id, jobNumber: j.job_number, source: j.source, vendorId: j.vendor_id, status: j.status, dueDate: j.due_date })) : undefined,
        cancellation: policy[i.id],
      };
    }),
    timeline: events
      .filter((e) => staff || e.is_customer_visible)
      .map((e) => ({ id: e.id, event: e.event, itemId: e.order_item_id, from: e.from_state, to: e.to_state, note: e.note, actor: staff ? e.actor?.name : undefined, at: e.created_at })),
    payments: pricing
      ? payments.map((p) => ({ id: p.id, provider: p.provider, purpose: p.purpose, amountPaise: p.amount_paise, status: p.status, method: p.method, reference: p.provider_payment_id, capturedAt: p.captured_at }))
      : [],
    refunds: pricing ? refunds.map((r) => ({ id: r.id, amountPaise: r.amount_paise, status: r.status, reason: r.reason, processedAt: r.processed_at })) : [],
    shipments: shipments.map((s) => ({
      id: s.id,
      shipmentNumber: s.shipment_number,
      carrier: s.carrier,
      trackingNumber: s.tracking_number,
      trackingUrl: s.tracking_url,
      status: s.status,
      dispatchedAt: s.dispatched_at,
      deliveredAt: s.delivered_at,
      itemIds: s.items.map((x) => x.order_item_id),
      events: s.trackingEvents.sort((a, b) => a.occurred_at - b.occurred_at).map((t) => ({ status: t.status, location: t.location, description: t.description, at: t.occurred_at })),
    })),
    invoice: pricing && invoice ? { id: invoice.id, number: invoice.invoice_number, issuedAt: invoice.issued_at, dueDate: invoice.due_date } : null,
    tickets,
    amountDue: pricing ? due : null,
    actions: {
      canPay: pricing && order.approval_status !== "pending" && due.amountPaise > 0 && !["cancelled", "refunded"].includes(order.status) && order.user_id === auth.user.id,
      canApprove: order.approval_status === "pending" && order.company_id === auth.companyId && auth.permissions.has("company.orders.approve"),
      canCancel: order.user_id === auth.user.id && items.some((i) => policy[i.id].allowed),
      canReorder: order.user_id === auth.user.id,
    },
  };
}

async function list(auth, { scope = "mine", page = 1, limit = 20, status, q } = {}) {
  const where = {};
  if (scope === "company") {
    if (!auth.companyId || !auth.permissions.has("company.view")) throw ApiError.forbidden();
    where.company_id = auth.companyId;
  } else if (scope === "all") {
    if (!auth.permissions.has("orders.view")) throw ApiError.forbidden();
  } else {
    where.user_id = auth.user.id;
  }
  if (status) where.status = status;
  if (q) where.order_number = { [Op.iLike]: `%${q}%` };
  const { rows, count } = await Order.findAndCountAll({
    where,
    order: [["placed_at", "DESC"]],
    limit,
    offset: (page - 1) * limit,
    include: [{ model: User, as: "customer", attributes: ["id", "name", "email"] }, { model: Company, as: "company", attributes: ["id", "name"] }],
  });
  const ids = rows.map((r) => r.id);
  const [counts] = ids.length
    ? await sequelize.query(
        `SELECT order_id, count(*)::int AS lines, sum(quantity)::int AS units,
                min(product_snapshot->>'image') AS image, min(product_snapshot->>'name') AS first_name
           FROM order_items WHERE order_id IN (:ids) GROUP BY order_id`,
        { replacements: { ids } }
      )
    : [[]];
  const byId = new Map(counts.map((c) => [c.order_id, c]));
  return {
    items: rows.map((o) => ({
      id: o.id,
      orderNumber: o.order_number,
      status: o.status,
      paymentStatus: o.payment_status,
      approvalStatus: o.approval_status,
      channel: o.channel,
      totalPaise: o.total_paise,
      amountPaidPaise: o.amount_paid_paise,
      placedAt: o.placed_at,
      poNumber: o.po_number,
      paymentTerms: o.payment_terms,
      customer: scope === "mine" ? undefined : o.customer,
      company: o.company,
      lines: byId.get(o.id)?.lines || 0,
      units: byId.get(o.id)?.units || 0,
      image: byId.get(o.id)?.image || null,
      summary: byId.get(o.id)?.first_name || "",
    })),
    total: count,
  };
}

async function timeline(auth, orderId) {
  const order = await detail(auth, orderId);
  return order.timeline;
}

// ------------------------------------------------------------------ cancellation
async function cancel(auth, orderId, { reason, itemIds }) {
  return sequelize.transaction(async (transaction) => {
    const order = await loadVisible(auth, orderId, { transaction, lock: true });
    const staff = auth.permissions.has("orders.manage");
    if (order.user_id !== auth.user.id && !staff) throw ApiError.forbidden();
    const items = await OrderItem.findAll({ where: { order_id: order.id }, transaction, lock: transaction.LOCK.UPDATE });
    const targets = itemIds?.length ? items.filter((i) => itemIds.includes(i.id)) : items.filter((i) => !machine.TERMINAL.includes(i.state));
    if (!targets.length) throw ApiError.unprocessable("Nothing left to cancel on this order", "NOTHING_TO_CANCEL");

    let charges = 0;
    for (const item of targets) {
      const effective = item.state === "on_hold" ? item.previous_state : item.state;
      let policy = machine.cancellationPolicy(effective);
      // Plain (uncustomised) items incur no setup or blank cost until production is assigned.
      if (!item.requires_proof && effective === "proof_approved") policy = { allowed: true, charges: false };
      if (!policy.allowed) {
        throw ApiError.conflict(`${item.product_snapshot.name} is already in production and cannot be cancelled`, "CANCEL_NOT_ALLOWED");
      }
      if (policy.charges) {
        // Setup and blank costs already incurred are retained (Section 7.6).
        const product = await Product.findByPk(item.product_id, { transaction });
        const blank = product.base_cost_paise * item.quantity;
        charges += Math.min(item.line_total_paise, item.setup_fee_paise + blank);
      }
    }
    for (const item of targets) {
      await transitionItem(item, "cancelled", { actorId: auth.user.id, note: reason, transaction, skipOrderRefresh: true });
      await ProductionJob.update({ status: "cancelled" }, { where: { order_item_id: item.id, status: { [Op.notIn]: ["dispatched", "delivered", "cancelled"] } }, transaction });
    }
    // Cancellation is only possible before production, so the reserved blanks go back into stock.
    await adjustStock(targets.map((t) => ({ variant_id: t.variant_id, quantity: t.quantity })), 1, {
      actorId: auth.user.id,
      reason: "order_cancel",
      transaction,
      orderId: order.id,
    });

    const allCancelled = (await OrderItem.count({ where: { order_id: order.id, state: { [Op.notIn]: ["cancelled", "refunded"] } }, transaction })) === 0;
    if (allCancelled) await order.update({ cancelled_at: new Date(), cancel_reason: reason }, { transaction });

    // Refund what was paid for the cancelled lines, less retained charges.
    // Whole order cancelled: everything paid (including shipping and its GST) less charges.
    const paidBalance = order.amount_paid_paise - order.amount_refunded_paise;
    const cancelledValue = allCancelled ? paidBalance : targets.reduce((s, i) => s + i.line_total_paise, 0);
    const refundable = Math.max(0, Math.min(paidBalance, cancelledValue - charges));
    let refund = null;
    if (refundable > 0) {
      const refundService = require("./refundService");
      refund = await refundService.createAndProcess(
        { order, amountPaise: refundable, reason: `Cancellation: ${reason}`, actorId: auth.user.id, autoApprove: true },
        { transaction }
      );
    }
    await event(order.id, null, "order_cancelled", { actorId: auth.user.id, note: `${targets.length} line(s) cancelled. ${charges ? `Charges retained ₹${(charges / 100).toFixed(2)}.` : "No charges."}`, transaction });
    await refreshOrderStatus(order.id, transaction);
    return { cancelledItems: targets.length, chargesPaise: charges, refund: refund ? { id: refund.id, amountPaise: refund.amount_paise, status: refund.status } : null };
  });
}

// ------------------------------------------------------------------ approvals
async function decideApproval(auth, orderId, { approve, comment }) {
  return sequelize.transaction(async (transaction) => {
    const order = await Order.findByPk(orderId, { transaction, lock: transaction.LOCK.UPDATE });
    if (!order || order.company_id !== auth.companyId) throw ApiError.notFound("Order not found");
    if (!auth.permissions.has("company.orders.approve")) throw ApiError.forbidden();
    if (order.approval_status !== "pending") throw ApiError.conflict("This order is not waiting for approval", "NOT_PENDING_APPROVAL");
    if (order.user_id === auth.user.id) throw ApiError.forbidden("You cannot approve your own order");
    await order.update({ approval_status: approve ? "approved" : "rejected", approved_by: auth.user.id, approved_at: new Date() }, { transaction });
    await event(order.id, null, approve ? "order_approved" : "order_rejected", { actorId: auth.user.id, note: comment, transaction });
    const items = await OrderItem.findAll({ where: { order_id: order.id }, transaction });
    if (approve) {
      for (const item of items) await transitionItem(item, "payment_pending", { actorId: auth.user.id, transaction, skipOrderRefresh: true });
      await refreshOrderStatus(order.id, transaction);
      await advanceAfterPayment(order.id, { actorId: auth.user.id, transaction });
    } else {
      for (const item of items) await transitionItem(item, "cancelled", { actorId: auth.user.id, note: "Rejected by approver", transaction, skipOrderRefresh: true });
      await adjustStock(items.map((i) => ({ variant_id: i.variant_id, quantity: i.quantity })), 1, { actorId: auth.user.id, reason: "order_cancel", transaction, orderId: order.id });
      await order.update({ cancelled_at: new Date(), cancel_reason: comment || "Rejected by approver" }, { transaction });
      await refreshOrderStatus(order.id, transaction);
    }
    await notificationService.notify(
      order.user_id,
      { type: "approval_decided", title: `Order ${order.order_number} ${approve ? "approved" : "rejected"}`, body: comment || (approve ? "You can now complete payment." : "Your approver rejected this order."), link: `/orders/${order.id}` },
      { transaction }
    );
    return { approvalStatus: order.approval_status };
  });
}

async function pendingApprovals(auth) {
  if (!auth.companyId) throw ApiError.forbidden();
  return Order.findAll({
    where: { company_id: auth.companyId, approval_status: "pending" },
    include: [{ model: User, as: "customer", attributes: ["id", "name", "email"] }],
    order: [["placed_at", "ASC"]],
  });
}

// ------------------------------------------------------------------ reorder
async function reorder(auth, orderId) {
  const order = await loadVisible(auth, orderId);
  if (order.user_id !== auth.user.id && order.company_id !== auth.companyId) throw ApiError.forbidden();
  const items = await OrderItem.findAll({ where: { order_id: order.id, reprint_of_item_id: null }, order: [["line_no", "ASC"]] });
  const added = [];
  const skipped = [];
  for (const item of items) {
    try {
      const version = item.design_version_id ? await DesignVersion.findByPk(item.design_version_id) : null;
      const lines = await cartService.addItem(auth, {
        productId: item.product_id,
        variantId: item.variant_id,
        methodId: item.method_id,
        quantity: item.quantity,
        designVersionId: version ? version.id : undefined,
        artworkAssetIds: item.product_snapshot.artworkAssetIds?.length ? item.product_snapshot.artworkAssetIds : undefined,
        printAreaCount: item.print_area_count,
        express: false,
      });
      added.push(...lines.map((l) => l.id));
    } catch (error) {
      skipped.push({ name: item.product_snapshot.name, reason: error.message });
    }
  }
  return { added: added.length, skipped };
}

// ------------------------------------------------------------------ housekeeping
// Close delivered lines once the complaint window ends without an open complaint.
async function closeDeliveredLines() {
  const { complaint_window_days: days } = await settingsService.get("orders");
  const cutoff = new Date(Date.now() - days * 86400 * 1000);
  const items = await OrderItem.findAll({ where: { state: "delivered", delivered_at: { [Op.lt]: cutoff } } });
  let closed = 0;
  for (const item of items) {
    const openComplaint = await Ticket.count({ where: { order_item_id: item.id, type: "complaint", status: { [Op.notIn]: ["resolved", "closed"] } } });
    if (openComplaint) continue;
    await sequelize.transaction(async (transaction) => {
      await transitionItem(item, "closed", { note: "Complaint window ended", transaction });
      await Commission.update({ eligible_at: new Date() }, { where: { order_item_id: item.id, eligible_at: null }, transaction });
    });
    closed++;
  }
  return closed;
}

// Admin: change a line state manually (on hold / resume etc.) with audit.
async function adminTransition(auth, itemId, { to, note }) {
  return sequelize.transaction(async (transaction) => {
    const item = await OrderItem.findByPk(itemId, { transaction, lock: transaction.LOCK.UPDATE });
    if (!item) throw ApiError.notFound("Order line not found");
    await transitionItem(item, to, { actorId: auth.user.id, note, transaction });
    return item;
  });
}

module.exports = {
  checkout,
  detail,
  list,
  timeline,
  cancel,
  decideApproval,
  pendingApprovals,
  reorder,
  closeDeliveredLines,
  adminTransition,
  transitionItem,
  refreshOrderStatus,
  advanceAfterPayment,
  amountDue,
  paymentConditionMet,
  loadVisible,
  event,
  adjustStock,
  addressSnapshot,
  paymentTermsFor,
  ownedAddress,
};
