// Request-for-quote workflow (Section 7.4, FR-BB-02/03):
// requested -> (under_review) -> sent -> revision_requested -> sent (new version) ...
//           -> accepted -> converted to an order at the quoted prices | rejected | expired.
// Staff can also return a request to the customer for correction:
// requested | under_review | revision_requested | resubmitted | sent -> correction_requested
//           -> (customer corrects) resubmitted -> under_review | sent (new version) ...
// Staff can reject any open quotation with a reason. Every step is recorded in quote_events.
const { Op } = require("sequelize");
const {
  sequelize,
  Quote,
  QuoteRequestItem,
  QuoteVersion,
  QuoteItem,
  QuoteMessage,
  QuoteEvent,
  Product,
  ProductVariant,
  DecorationMethod,
  Company,
  User,
  Order,
  OrderItem,
  ArtworkAsset,
} = require("../Models");
const ApiError = require("../Utils/ApiError");
const { nextNumber } = require("../Utils/numbering");
const pricingService = require("./pricingService");
const engine = require("./pricingEngine");
const settingsService = require("./settingsService");
const notificationService = require("./notificationService");
const assetService = require("./assetService");
const designService = require("./designService");

const orderService = () => require("./orderService");

async function notifyQuoteTeam(payload) {
  await require("./productionService").notifyStaff("quotes.manage", payload);
}

// Statuses in which staff may act. Accepted, converted, rejected, expired and cancelled
// quotations are closed to these actions (expired ones can still be re-priced, as before).
const PRICEABLE = ["requested", "under_review", "revision_requested", "resubmitted", "sent", "expired"];
const RETURNABLE = ["requested", "under_review", "revision_requested", "resubmitted", "sent"];
const DECLINABLE = ["requested", "under_review", "revision_requested", "resubmitted", "correction_requested", "sent"];

const CATEGORY_LABELS = {
  pricing: "Pricing",
  quantity: "Quantity",
  product: "Product",
  artwork: "Logo / artwork",
  customization: "Customisation",
  tax: "GST / tax",
  delivery: "Delivery",
  payment_terms: "Payment terms",
  other: "Other",
};

const customerLink = (quote) => `/${quote.company_id ? "business/" : ""}quotations/${quote.id}`;

/** True when the user may act for the customer on this quotation (requester or company member). */
function actsForCustomer(auth, quote) {
  return quote.requester_user_id === auth.user.id || Boolean(quote.company_id && quote.company_id === auth.companyId && auth.permissions.has("company.view"));
}

// Who may accept or reject a quotation: the requester, or (for a company quotation) a company
// approver - the people who may commit company spend.
function decidesForCustomer(auth, quote) {
  return quote.requester_user_id === auth.user.id || Boolean(quote.company_id && quote.company_id === auth.companyId && auth.permissions.has("company.orders.approve"));
}

/** What the signed-in user may do with a quotation now (the UI shows only these; the endpoints enforce the same rules). */
function actionsFor(auth, quote) {
  const manage = auth.permissions.has("quotes.manage");
  const request = auth.permissions.has("quotes.request");
  const mine = decidesForCustomer(auth, quote);
  return {
    canAccept: quote.status === "sent" && mine,
    canRequestRevision: quote.status === "sent" && actsForCustomer(auth, quote),
    canReject: ["sent", "revision_requested", "correction_requested"].includes(quote.status) && mine,
    canResubmit: quote.status === "correction_requested" && request && actsForCustomer(auth, quote),
    canPrice: manage && PRICEABLE.includes(quote.status),
    canReview: manage && ["requested", "resubmitted"].includes(quote.status),
    canReturn: manage && RETURNABLE.includes(quote.status),
    canDecline: manage && DECLINABLE.includes(quote.status),
    canDownload: Boolean(quote.current_version_id),
  };
}

/** Appends one history row. History is never updated or deleted. */
async function recordEvent(quote, { actorId = null, role, event, from, to, versionNo = null, category = null, reason = null, instructions = null, internalNote = null, changes = [], snapshot = null }, transaction) {
  return QuoteEvent.create(
    {
      quote_id: quote.id,
      actor_user_id: actorId,
      actor_role: role,
      event,
      from_status: from || null,
      to_status: to || null,
      request_revision: quote.request_revision || 1,
      version_no: versionNo,
      category,
      reason,
      instructions,
      internal_note: internalNote,
      changes,
      snapshot,
    },
    { transaction }
  );
}

/** The customer's request as it stands: kept with each edit so every revision can be reproduced. */
async function requestSnapshot(quote, transaction) {
  const items = await QuoteRequestItem.findAll({
    where: { quote_id: quote.id },
    include: [
      { model: Product, as: "product", attributes: ["id", "name"] },
      { model: ProductVariant, as: "variant", attributes: ["id", "sku", "attributes"] },
      { model: DecorationMethod, as: "method", attributes: ["id", "name"] },
    ],
    order: [["id", "ASC"]],
    transaction,
  });
  return {
    requestRevision: quote.request_revision || 1,
    title: quote.title,
    deadline: quote.deadline,
    budgetPaise: quote.budget_paise,
    deliveryLocations: quote.delivery_locations,
    deliveryPincode: quote.delivery_pincode,
    notes: quote.notes,
    items: items.map((i) => ({
      id: i.id,
      productId: i.product_id,
      product: i.product?.name || null,
      variantId: i.variant_id,
      variant: i.variant ? Object.values(i.variant.attributes || {}).join(" / ") || i.variant.sku : null,
      methodId: i.method_id,
      method: i.method?.name || null,
      quantity: i.quantity,
      sizeBreakdown: i.size_breakdown,
      printAreaCount: i.print_area_count,
      artworkAssetIds: i.artwork_asset_ids,
      notes: i.notes,
    })),
  };
}

function visibleWhere(auth, scope) {
  if (scope === "all") {
    if (!auth.permissions.has("quotes.view")) throw ApiError.forbidden();
    return {};
  }
  if (auth.companyId && auth.permissions.has("company.view")) return { company_id: auth.companyId };
  return { requester_user_id: auth.user.id };
}

async function loadVisible(auth, id, { transaction, lock } = {}) {
  const quote = await Quote.findByPk(id, { transaction, lock: lock ? transaction.LOCK.UPDATE : undefined });
  if (!quote) throw ApiError.notFound("Quotation not found");
  const mine = quote.requester_user_id === auth.user.id;
  const company = quote.company_id && quote.company_id === auth.companyId && auth.permissions.has("company.view");
  const staff = auth.permissions.has("quotes.view");
  if (!mine && !company && !staff) throw ApiError.notFound("Quotation not found");
  return quote;
}

// Expiry is also checked on read so a stale quote can never be accepted.
async function expireIfDue(quote, transaction) {
  if (!["sent", "revision_requested"].includes(quote.status) || !quote.current_version_id) return quote;
  const version = await QuoteVersion.findByPk(quote.current_version_id, { transaction });
  if (version && version.valid_until < new Date().toISOString().slice(0, 10)) {
    const from = quote.status;
    await quote.update({ status: "expired" }, { transaction });
    await recordEvent(quote, { role: "system", event: "expired", from, to: "expired", versionNo: version.version_no }, transaction);
  }
  return quote;
}

async function create(auth, input) {
  return sequelize.transaction(async (transaction) => {
    const artworkIds = input.items.flatMap((i) => i.artworkAssetIds || []);
    await assetService.assertUsable(auth, artworkIds);
    const quote = await Quote.create(
      {
        quote_number: await nextNumber("quote", transaction),
        requester_user_id: auth.user.id,
        company_id: auth.companyId || null,
        status: "requested",
        title: input.title,
        deadline: input.deadline || null,
        budget_paise: input.budgetPaise || null,
        delivery_locations: input.deliveryLocations || null,
        delivery_pincode: input.deliveryPincode || null,
        notes: input.notes || null,
        recipients: input.recipients || [],
        is_repeat_of: input.repeatOf || null,
      },
      { transaction }
    );
    for (const item of input.items) {
      const product = await Product.findOne({ where: { id: item.productId, status: "active" }, transaction });
      if (!product) throw ApiError.unprocessable("One of the products is not available", "PRODUCT_UNAVAILABLE");
      if (item.variantId) {
        const variant = await ProductVariant.findOne({ where: { id: item.variantId, product_id: product.id }, transaction });
        if (!variant) throw ApiError.unprocessable(`Choose a valid option for ${product.name}`, "VARIANT_INVALID");
      }
      if (item.designVersionId) await designService.usableVersion(auth, item.designVersionId, product.id, { transaction });
      const sizeTotal = item.sizeBreakdown ? Object.values(item.sizeBreakdown).reduce((s, n) => s + Number(n), 0) : 0;
      await QuoteRequestItem.create(
        {
          quote_id: quote.id,
          product_id: product.id,
          variant_id: item.variantId || null,
          method_id: item.methodId || null,
          quantity: sizeTotal || item.quantity,
          size_breakdown: item.sizeBreakdown || null,
          print_area_count: item.printAreaCount ?? 1,
          artwork_asset_ids: item.artworkAssetIds || [],
          design_version_id: item.designVersionId || null,
          notes: item.notes || null,
        },
        { transaction }
      );
    }
    if (input.message) await QuoteMessage.create({ quote_id: quote.id, user_id: auth.user.id, body: input.message }, { transaction });
    await recordEvent(quote, { actorId: auth.user.id, role: "customer", event: "created", to: "requested", snapshot: await requestSnapshot(quote, transaction) }, transaction);
    transaction.afterCommit(() =>
      notifyQuoteTeam({ type: "quote_requested", title: `New quote request ${quote.quote_number}`, body: input.title, link: `/admin/quotations/${quote.id}` }).catch(() => {})
    );
    return quote;
  });
}

async function list(auth, { scope = "mine", status, page = 1, limit = 20, q }) {
  const where = visibleWhere(auth, scope);
  if (status) where.status = status;
  if (q) where[Op.or] = [{ quote_number: { [Op.iLike]: `%${q}%` } }, { title: { [Op.iLike]: `%${q}%` } }];
  const { rows, count } = await Quote.findAndCountAll({
    where,
    include: [
      { model: User, as: "requester", attributes: ["id", "name", "email"] },
      { model: Company, as: "company", attributes: ["id", "name"] },
      { model: QuoteVersion, as: "currentVersion", attributes: ["id", "version_no", "total_paise", "valid_until", "payment_terms"] },
    ],
    order: [["created_at", "DESC"]],
    limit,
    offset: (page - 1) * limit,
  });
  for (const quote of rows) await expireIfDue(quote);
  const [counts] = rows.length
    ? await sequelize.query(`SELECT quote_id, count(*)::int AS lines, sum(quantity)::int AS units FROM quote_request_items WHERE quote_id IN (:ids) GROUP BY quote_id`, { replacements: { ids: rows.map((r) => r.id) } })
    : [[]];
  const byId = new Map(counts.map((c) => [c.quote_id, c]));
  const orderIds = rows.map((r) => r.order_id).filter(Boolean);
  const orders = orderIds.length ? await Order.findAll({ where: { id: orderIds }, attributes: ["id", "order_number", "status", "confirmation_status"] }) : [];
  const orderOf = new Map(orders.map((o) => [o.id, { id: o.id, orderNumber: o.order_number, status: o.status, confirmationStatus: o.confirmation_status }]));
  return {
    items: rows.map((r) => ({ ...r.toJSON(), lines: byId.get(r.id)?.lines || 0, units: byId.get(r.id)?.units || 0, order: orderOf.get(r.order_id) || null, actions: actionsFor(auth, r) })),
    total: count,
  };
}

async function detail(auth, id) {
  const quote = await expireIfDue(await loadVisible(auth, id));
  const staff = auth.permissions.has("quotes.view");
  const [requestItems, versions, messages, requester, company] = await Promise.all([
    QuoteRequestItem.findAll({
      where: { quote_id: quote.id },
      include: [
        { model: Product, as: "product", attributes: ["id", "name", "slug", "images", "moq", "hsn_code", "gst_rate"] },
        { model: ProductVariant, as: "variant", attributes: ["id", "sku", "attributes", "image"] },
        { model: DecorationMethod, as: "method", attributes: ["id", "name"] },
      ],
    }),
    QuoteVersion.findAll({ where: { quote_id: quote.id }, include: [{ model: QuoteItem, as: "items" }], order: [["version_no", "DESC"]] }),
    QuoteMessage.findAll({ where: { quote_id: quote.id }, include: [{ model: User, as: "user", attributes: ["id", "name"] }], order: [["created_at", "ASC"]] }),
    User.findByPk(quote.requester_user_id, { attributes: ["id", "name", "email", "phone"] }),
    quote.company_id ? Company.findByPk(quote.company_id, { attributes: ["id", "name", "gstin", "payment_terms", "credit_approved", "billing_address"] }) : null,
  ]);
  const assetIds = [...new Set(requestItems.flatMap((i) => i.artwork_asset_ids))];
  const assets = assetIds.length ? await ArtworkAsset.findAll({ where: { id: assetIds } }) : [];
  const byId = new Map(assets.map((a) => [a.id, assetService.present(a)]));
  const current = versions.find((v) => v.id === quote.current_version_id) || null;
  const visibleVersions = staff ? versions : versions.filter((v) => v.sent_at);
  const [correction, resubmission] = await Promise.all(
    ["correction_requested", "resubmitted"].map((event) =>
      QuoteEvent.findOne({ where: { quote_id: quote.id, event }, include: [{ model: User, as: "actor", attributes: ["id", "name"] }], order: [["id", "DESC"]] })
    )
  );
  return {
    ...quote.toJSON(),
    requester,
    company,
    requestItems: requestItems.map((i) => ({ ...i.toJSON(), artwork: i.artwork_asset_ids.map((a) => byId.get(a)).filter(Boolean) })),
    versions: visibleVersions,
    currentVersion: current && (staff || current.sent_at) ? current : null,
    messages: messages.map((m) => ({ id: m.id, body: m.body, user: m.user?.name, isMine: m.user_id === auth.user.id, at: m.created_at })),
    // The latest return-for-correction: shown to the customer while it is open, and to staff
    // always. The internal note is staff-only.
    correction:
      correction && (staff || quote.status === "correction_requested")
        ? {
            category: correction.category,
            categoryLabel: CATEGORY_LABELS[correction.category] || correction.category,
            reason: correction.reason,
            instructions: correction.instructions,
            requestRevision: correction.request_revision,
            by: correction.actor?.name || null,
            at: correction.created_at,
            ...(staff ? { internalNote: correction.internal_note } : {}),
          }
        : null,
    resubmission: resubmission ? { comment: resubmission.reason, changes: resubmission.changes, requestRevision: resubmission.request_revision, by: resubmission.actor?.name || null, at: resubmission.created_at } : null,
    actions: actionsFor(auth, quote),
    order: quote.order_id ? await Order.findByPk(quote.order_id, { attributes: ["id", "order_number", "status", "confirmation_status"] }).then((o) => o && { id: o.id, orderNumber: o.order_number, status: o.status, confirmationStatus: o.confirmation_status }) : null,
    flow: await require("./salesFlowService").forQuote(quote),
  };
}

// Pricing suggestion for staff: the engine's price for each requested line (estimate).
async function suggest(auth, id) {
  const quote = await loadVisible(auth, id);
  const items = await QuoteRequestItem.findAll({ where: { quote_id: quote.id } });
  const out = [];
  for (const item of items) {
    const product = await pricingService.loadProduct(item.product_id);
    let line;
    try {
      line = pricingService.priceLine(product, {
        variantId: item.variant_id || undefined,
        methodId: item.method_id,
        quantity: item.quantity,
        printAreaCount: item.print_area_count,
        enforceCheckout: false,
      });
    } catch (error) {
      out.push({ requestItemId: item.id, productId: product.id, error: error.message });
      continue;
    }
    out.push({
      requestItemId: item.id,
      productId: product.id,
      variantId: line.variant.id,
      methodId: line.methodId,
      description: `${product.name}${line.methodName ? ` - ${line.methodName}` : ""}`,
      quantity: item.quantity,
      sizeBreakdown: item.size_breakdown,
      unitPricePaise: line.unitPricePaise,
      setupFeePaise: line.setupFeePaise,
      unitCostPaise: line.unitCostPaise,
      marginPct: line.tier.marginPct,
      gstRate: line.gstRate,
      hsnCode: line.hsnCode,
      leadTimeDays: line.leadTimeDays,
    });
  }
  return out;
}

async function sendVersion(auth, id, input) {
  return sequelize.transaction(async (transaction) => {
    const quote = await loadVisible(auth, id, { transaction, lock: true });
    if (!PRICEABLE.includes(quote.status)) {
      const why = quote.status === "correction_requested" ? "is waiting for the customer's corrections and" : `is ${quote.status.replace(/_/g, " ")} and`;
      throw ApiError.conflict(`This quotation ${why} cannot be priced now`, "QUOTE_CLOSED");
    }
    const fromStatus = quote.status;
    const seller = await settingsService.get("seller");
    const company = quote.company_id ? await Company.findByPk(quote.company_id, { transaction }) : null;
    const buyerState = company?.billing_address?.state;
    const interstate = buyerState ? buyerState.trim().toLowerCase() !== seller.state.trim().toLowerCase() : false;

    let subtotal = 0;
    let setupTotal = 0;
    let tax = 0;
    const lines = [];
    for (const item of input.items) {
      const product = await Product.findByPk(item.productId, { transaction });
      if (!product) throw ApiError.unprocessable("Unknown product on the quotation", "PRODUCT_INVALID");
      const lineTotal = item.unitPricePaise * item.quantity;
      subtotal += lineTotal;
      setupTotal += item.setupFeePaise || 0;
      lines.push({ item, product, lineTotal });
    }
    const shares = engine.allocateDiscount(lines.map((l) => l.lineTotal), input.discountPaise || 0);
    lines.forEach((l, i) => {
      l.tax = engine.gst(l.lineTotal - shares[i], Number(l.product.gst_rate), interstate).total;
      tax += l.tax;
    });
    const shippingCfg = await settingsService.get("shipping");
    const extras = (input.packagingPaise || 0) + (input.shippingPaise || 0);
    tax += engine.gst(extras, shippingCfg.gst_rate, interstate).total;
    const versionNo = ((await QuoteVersion.max("version_no", { where: { quote_id: quote.id }, transaction })) || 0) + 1;
    const { quote_validity_days: validityDays } = await settingsService.get("orders");
    const validUntil = input.validUntil || new Date(Date.now() + validityDays * 86400 * 1000).toISOString().slice(0, 10);
    const version = await QuoteVersion.create(
      {
        quote_id: quote.id,
        version_no: versionNo,
        valid_until: validUntil,
        production_days: input.productionDays,
        payment_terms: input.paymentTerms,
        subtotal_paise: subtotal,
        setup_fees_paise: setupTotal,
        packaging_paise: input.packagingPaise || 0,
        shipping_paise: input.shippingPaise || 0,
        discount_paise: input.discountPaise || 0,
        tax_paise: tax,
        total_paise: subtotal - (input.discountPaise || 0) + extras + tax,
        notes: input.notes || null,
        created_by: auth.user.id,
        sent_at: new Date(),
        request_revision: quote.request_revision || 1,
      },
      { transaction }
    );
    for (const [i, l] of lines.entries()) {
      await QuoteItem.create(
        {
          quote_version_id: version.id,
          request_item_id: l.item.requestItemId || null,
          product_id: l.product.id,
          variant_id: l.item.variantId || null,
          method_id: l.item.methodId || null,
          description: l.item.description,
          quantity: l.item.quantity,
          size_breakdown: l.item.sizeBreakdown || null,
          unit_price_paise: l.item.unitPricePaise,
          setup_fee_paise: l.item.setupFeePaise || 0,
          hsn_code: l.product.hsn_code,
          gst_rate: l.product.gst_rate,
          line_total_paise: l.lineTotal - shares[i],
          tax_paise: l.tax,
        },
        { transaction }
      );
    }
    await quote.update(
      { status: "sent", current_version_id: version.id, assigned_admin_id: quote.assigned_admin_id || auth.user.id, first_response_at: quote.first_response_at || new Date() },
      { transaction }
    );
    await recordEvent(quote, { actorId: auth.user.id, role: "staff", event: "version_sent", from: fromStatus, to: "sent", versionNo }, transaction);
    await notificationService.notify(
      quote.requester_user_id,
      { type: "quote_sent", title: `Quotation ${quote.quote_number} ${versionNo > 1 ? "revised" : "ready"}`, body: `Total ₹${(version.total_paise / 100).toFixed(2)}, valid until ${validUntil}.`, link: `/${quote.company_id ? "business/" : ""}quotations/${quote.id}` },
      { transaction }
    );
    return version;
  });
}

// Staff take a new or resubmitted request into review (other statuses are left as they are).
async function markUnderReview(auth, id) {
  return sequelize.transaction(async (transaction) => {
    const quote = await loadVisible(auth, id, { transaction, lock: true });
    if (!["requested", "resubmitted"].includes(quote.status)) return quote;
    const from = quote.status;
    await quote.update({ status: "under_review", assigned_admin_id: quote.assigned_admin_id || auth.user.id, first_response_at: quote.first_response_at || new Date() }, { transaction });
    await recordEvent(quote, { actorId: auth.user.id, role: "staff", event: "under_review", from, to: "under_review" }, transaction);
    return quote;
  });
}

async function requestRevision(auth, id, { comment }) {
  return sequelize.transaction(async (transaction) => {
    const quote = await expireIfDue(await loadVisible(auth, id, { transaction, lock: true }), transaction);
    if (!actsForCustomer(auth, quote)) throw ApiError.forbidden("Only the customer can ask for a revision");
    if (quote.status !== "sent") throw ApiError.conflict("This quotation cannot be revised now", "QUOTE_NOT_SENT");
    await quote.update({ status: "revision_requested" }, { transaction });
    await QuoteMessage.create({ quote_id: quote.id, user_id: auth.user.id, body: `Revision requested: ${comment}` }, { transaction });
    await recordEvent(quote, { actorId: auth.user.id, role: "customer", event: "revision_requested", from: "sent", to: "revision_requested", reason: comment }, transaction);
    transaction.afterCommit(() => notifyQuoteTeam({ type: "quote_revision", title: `Revision requested on ${quote.quote_number}`, body: comment, link: `/admin/quotations/${quote.id}` }).catch(() => {}));
    return quote;
  });
}

async function reject(auth, id, { reason }) {
  return sequelize.transaction(async (transaction) => {
    const quote = await loadVisible(auth, id, { transaction, lock: true });
    if (!decidesForCustomer(auth, quote)) throw ApiError.forbidden("Only the requester or a company approver can reject this quotation");
    if (!["sent", "revision_requested", "correction_requested"].includes(quote.status)) throw ApiError.conflict("This quotation cannot be rejected now", "QUOTE_CLOSED");
    const from = quote.status;
    await quote.update({ status: "rejected" }, { transaction });
    if (reason) await QuoteMessage.create({ quote_id: quote.id, user_id: auth.user.id, body: `Rejected: ${reason}` }, { transaction });
    await recordEvent(quote, { actorId: auth.user.id, role: "customer", event: "rejected", from, to: "rejected", reason: reason || null }, transaction);
    return quote;
  });
}

/** Staff return a request to the customer for correction (reason and category are required). */
async function returnToCustomer(auth, id, { reason, category, instructions, internalNote }) {
  return sequelize.transaction(async (transaction) => {
    const quote = await expireIfDue(await loadVisible(auth, id, { transaction, lock: true }), transaction);
    if (!RETURNABLE.includes(quote.status)) {
      throw ApiError.conflict(`A quotation that is ${quote.status.replace(/_/g, " ")} cannot be sent back to the customer`, "QUOTE_NOT_RETURNABLE");
    }
    const from = quote.status;
    await quote.update({ status: "correction_requested", assigned_admin_id: quote.assigned_admin_id || auth.user.id, first_response_at: quote.first_response_at || new Date() }, { transaction });
    await recordEvent(
      quote,
      { actorId: auth.user.id, role: "staff", event: "correction_requested", from, to: "correction_requested", category, reason, instructions: instructions || null, internalNote: internalNote || null },
      transaction
    );
    await notificationService.notify(
      quote.requester_user_id,
      {
        type: "quote_correction",
        title: `Quotation ${quote.quote_number} needs your corrections`,
        body: `${CATEGORY_LABELS[category]}: ${reason}${instructions ? `\n${instructions}` : ""}\nPlease update your request and resubmit it.`,
        link: customerLink(quote),
      },
      { transaction }
    );
    return quote;
  });
}

/** Staff reject a quotation; the reason is shown to the customer. */
async function decline(auth, id, { reason, internalNote }) {
  return sequelize.transaction(async (transaction) => {
    const quote = await loadVisible(auth, id, { transaction, lock: true });
    if (!DECLINABLE.includes(quote.status)) {
      throw ApiError.conflict(`A quotation that is ${quote.status.replace(/_/g, " ")} cannot be rejected`, "QUOTE_CLOSED");
    }
    const from = quote.status;
    await quote.update({ status: "rejected" }, { transaction });
    await recordEvent(quote, { actorId: auth.user.id, role: "staff", event: "rejected", from, to: "rejected", reason, internalNote: internalNote || null }, transaction);
    await notificationService.notify(
      quote.requester_user_id,
      { type: "quote_rejected", title: `Quotation ${quote.quote_number} was declined`, body: reason, link: customerLink(quote) },
      { transaction }
    );
    return quote;
  });
}

const sameValue = (a, b) => JSON.stringify(a ?? null) === JSON.stringify(b ?? null);

/**
 * The customer corrects a returned request and sends it back. Only request details can change
 * (items, quantities, options, artwork, dates, delivery, notes): prices, terms, staff notes and
 * the status are never taken from this input. The request as it was is kept in the history.
 */
async function resubmit(auth, id, input) {
  return sequelize.transaction(async (transaction) => {
    const quote = await loadVisible(auth, id, { transaction, lock: true });
    if (!actsForCustomer(auth, quote)) throw ApiError.forbidden("Only the customer can correct this quotation");
    if (quote.status !== "correction_requested") {
      throw ApiError.conflict(quote.status === "resubmitted" ? "This quotation has already been resubmitted" : "This quotation is not waiting for corrections", "QUOTE_NOT_RETURNED");
    }
    const before = await requestSnapshot(quote, transaction);
    const changes = [];

    // Request details.
    const fields = [
      ["title", "title", "Title"],
      ["deadline", "deadline", "Needed by"],
      ["budgetPaise", "budget_paise", "Budget"],
      ["deliveryLocations", "delivery_locations", "Delivery locations"],
      ["deliveryPincode", "delivery_pincode", "Delivery pincode"],
      ["notes", "notes", "Notes"],
    ];
    const updates = {};
    for (const [key, column, label] of fields) {
      if (input[key] === undefined) continue;
      const next = input[key] ?? null;
      if (sameValue(quote[column], next)) continue;
      changes.push({ field: key, label, from: quote[column] ?? null, to: next });
      updates[column] = next;
    }

    // Line items: only lines already on this request can be edited or removed.
    const items = await QuoteRequestItem.findAll({ where: { quote_id: quote.id }, transaction });
    const byId = new Map(items.map((i) => [i.id, i]));
    const removing = new Set();
    for (const edit of input.items || []) {
      const item = byId.get(edit.id);
      if (!item) throw ApiError.unprocessable("One of the items is not on this quotation", "QUOTE_ITEM_INVALID");
      const name = before.items.find((i) => i.id === item.id)?.product || "Item";
      if (edit.remove) {
        removing.add(item.id);
        changes.push({ field: "item.removed", label: `${name}: removed`, itemId: item.id, from: before.items.find((i) => i.id === item.id), to: null });
        continue;
      }
      const next = {};
      if (edit.variantId !== undefined && !sameValue(item.variant_id, edit.variantId)) {
        if (edit.variantId) {
          const variant = await ProductVariant.findOne({ where: { id: edit.variantId, product_id: item.product_id }, transaction });
          if (!variant) throw ApiError.unprocessable(`Choose a valid option for ${name}`, "VARIANT_INVALID");
        }
        next.variant_id = edit.variantId;
      }
      if (edit.methodId !== undefined && !sameValue(item.method_id, edit.methodId)) {
        if (edit.methodId && !(await DecorationMethod.findByPk(edit.methodId, { transaction }))) throw ApiError.unprocessable(`Choose a valid decoration method for ${name}`, "METHOD_INVALID");
        next.method_id = edit.methodId;
      }
      if (edit.sizeBreakdown !== undefined && !sameValue(item.size_breakdown, edit.sizeBreakdown)) {
        next.size_breakdown = edit.sizeBreakdown;
        const sizeTotal = edit.sizeBreakdown ? Object.values(edit.sizeBreakdown).reduce((s, n) => s + Number(n), 0) : 0;
        if (sizeTotal && sizeTotal !== item.quantity) next.quantity = sizeTotal;
      }
      if (edit.quantity !== undefined && next.quantity === undefined && edit.quantity !== item.quantity) next.quantity = edit.quantity;
      if (edit.printAreaCount !== undefined && edit.printAreaCount !== item.print_area_count) next.print_area_count = edit.printAreaCount;
      if (edit.artworkAssetIds !== undefined && !sameValue([...item.artwork_asset_ids].sort(), [...edit.artworkAssetIds].sort())) {
        await assetService.assertUsable(auth, edit.artworkAssetIds);
        next.artwork_asset_ids = edit.artworkAssetIds;
      }
      if (edit.notes !== undefined && !sameValue(item.notes, edit.notes)) next.notes = edit.notes;
      const labels = { variant_id: "option", method_id: "decoration method", size_breakdown: "size split", quantity: "quantity", print_area_count: "print areas", artwork_asset_ids: "artwork", notes: "notes" };
      for (const [column, value] of Object.entries(next)) {
        changes.push({ field: `item.${column}`, label: `${name}: ${labels[column]}`, itemId: item.id, from: item[column] ?? null, to: value ?? null });
      }
      if (Object.keys(next).length) await item.update(next, { transaction });
    }
    if (removing.size >= items.length) throw ApiError.unprocessable("Keep at least one item on the quotation", "QUOTE_ITEMS_REQUIRED");
    if (removing.size) await QuoteRequestItem.destroy({ where: { id: [...removing], quote_id: quote.id }, transaction });

    const revision = (quote.request_revision || 1) + 1;
    await quote.update({ ...updates, status: "resubmitted", request_revision: revision }, { transaction });
    await recordEvent(quote, { actorId: auth.user.id, role: "customer", event: "resubmitted", from: "correction_requested", to: "resubmitted", reason: input.comment, changes, snapshot: before }, transaction);
    transaction.afterCommit(() =>
      notifyQuoteTeam({
        type: "quote_resubmitted",
        title: `${quote.quote_number} resubmitted with corrections (revision ${revision})`,
        body: `${changes.length} change(s). ${input.comment}`,
        link: `/admin/quotations/${quote.id}`,
      }).catch(() => {})
    );
    return { quote, changes, requestRevision: revision };
  });
}

/** Full history: every event (with field changes) and every priced version. Internal notes are staff-only. */
async function history(auth, id) {
  const quote = await loadVisible(auth, id);
  const staff = auth.permissions.has("quotes.view");
  const [events, versions] = await Promise.all([
    QuoteEvent.findAll({ where: { quote_id: quote.id }, include: [{ model: User, as: "actor", attributes: ["id", "name"] }], order: [["id", "ASC"]] }),
    QuoteVersion.findAll({ where: { quote_id: quote.id }, include: [{ model: User, as: "author", attributes: ["id", "name"] }], order: [["version_no", "DESC"]] }),
  ]);
  return {
    quoteNumber: quote.quote_number,
    status: quote.status,
    requestRevision: quote.request_revision || 1,
    currentVersionId: quote.current_version_id,
    events: events.map((e) => ({
      id: e.id,
      event: e.event,
      actorRole: e.actor_role,
      actor: e.actor?.name || (e.actor_role === "system" ? "System" : null),
      fromStatus: e.from_status,
      toStatus: e.to_status,
      requestRevision: e.request_revision,
      versionNo: e.version_no,
      category: e.category,
      categoryLabel: e.category ? CATEGORY_LABELS[e.category] || e.category : null,
      reason: e.reason,
      instructions: e.instructions,
      changes: e.changes || [],
      snapshot: e.snapshot,
      at: e.created_at,
      ...(staff ? { internalNote: e.internal_note } : {}),
    })),
    versions: versions
      .filter((v) => staff || v.sent_at)
      .map((v) => ({
        id: v.id,
        versionNo: v.version_no,
        requestRevision: v.request_revision || 1,
        totalPaise: Number(v.total_paise),
        validUntil: v.valid_until,
        paymentTerms: v.payment_terms,
        sentAt: v.sent_at,
        createdAt: v.created_at,
        preparedBy: v.author?.name || null,
        isCurrent: v.id === quote.current_version_id,
      })),
  };
}

/**
 * The quotation document (printable / PDF) for one version: the current one by default, any
 * earlier one by number. Versions are immutable, so earlier documents reproduce exactly. Tax is
 * the amount computed when the version was sent, split CGST/SGST or IGST by the same place-of-
 * supply rule that priced it.
 */
async function document(auth, id, { version: versionNo } = {}) {
  const quote = await loadVisible(auth, id);
  const staff = auth.permissions.has("quotes.view");
  const where = versionNo ? { quote_id: quote.id, version_no: versionNo } : { id: quote.current_version_id || null };
  const version = await QuoteVersion.findOne({ where, include: [{ model: QuoteItem, as: "items" }] });
  if (!version || version.quote_id !== quote.id || (!staff && !version.sent_at)) throw ApiError.notFound("This quotation has not been priced yet");
  const [seller, requester, company] = await Promise.all([
    settingsService.get("seller"),
    User.findByPk(quote.requester_user_id, { attributes: ["id", "name", "email", "phone"] }),
    quote.company_id ? Company.findByPk(quote.company_id, { attributes: ["id", "name", "gstin", "billing_address"] }) : null,
  ]);
  const buyerState = company?.billing_address?.state;
  const interstate = buyerState ? buyerState.trim().toLowerCase() !== seller.state.trim().toLowerCase() : false;
  const split = (total) => (interstate ? { cgst: 0, sgst: 0, igst: total } : { cgst: Math.floor(total / 2), sgst: total - Math.floor(total / 2), igst: 0 });
  const tax = split(Number(version.tax_paise));
  const lineTax = version.items.reduce((s, i) => s + Number(i.tax_paise), 0);
  return {
    quoteId: quote.id,
    quoteNumber: quote.quote_number,
    title: quote.title,
    status: quote.status,
    versionNo: version.version_no,
    requestRevision: version.request_revision || 1,
    isCurrent: version.id === quote.current_version_id,
    latestVersionNo: (await QuoteVersion.max("version_no", { where: staff ? { quote_id: quote.id } : { quote_id: quote.id, sent_at: { [Op.ne]: null } } })) || version.version_no,
    issuedAt: version.sent_at || version.created_at,
    validUntil: version.valid_until,
    productionDays: version.production_days,
    paymentTerms: version.payment_terms,
    deadline: quote.deadline,
    seller,
    buyer: {
      name: company?.name || requester?.name,
      contact: requester?.name,
      email: requester?.email,
      phone: requester?.phone,
      gstin: company?.gstin || null,
      address: company?.billing_address || null,
    },
    placeOfSupply: buyerState || seller.state,
    isInterstate: interstate,
    items: version.items.map((i, n) => ({
      lineNo: n + 1,
      description: i.description,
      hsnCode: i.hsn_code,
      quantity: i.quantity,
      sizeBreakdown: i.size_breakdown,
      unitPricePaise: Number(i.unit_price_paise),
      setupFeePaise: Number(i.setup_fee_paise),
      grossPaise: Number(i.unit_price_paise) * i.quantity,
      discountPaise: Number(i.unit_price_paise) * i.quantity - Number(i.line_total_paise),
      taxablePaise: Number(i.line_total_paise),
      gstRate: Number(i.gst_rate),
      taxPaise: Number(i.tax_paise),
    })),
    subtotalPaise: Number(version.subtotal_paise),
    discountPaise: Number(version.discount_paise),
    packagingPaise: Number(version.packaging_paise),
    shippingPaise: Number(version.shipping_paise),
    chargesTaxPaise: Number(version.tax_paise) - lineTax,
    cgstPaise: tax.cgst,
    sgstPaise: tax.sgst,
    igstPaise: tax.igst,
    taxPaise: Number(version.tax_paise),
    totalPaise: Number(version.total_paise),
    notes: version.notes,
  };
}

/** Accepting converts the quote into an order at the quoted prices (no repricing). */
async function accept(auth, id, { addressId, poNumber, gstin }) {
  return sequelize.transaction(async (transaction) => {
    const quote = await expireIfDue(await loadVisible(auth, id, { transaction, lock: true }), transaction);
    if (!decidesForCustomer(auth, quote)) throw ApiError.forbidden("Only the requester or a company approver can accept this quotation");
    if (quote.status === "expired") throw ApiError.conflict("This quotation has expired. Ask us to revise it.", "QUOTE_EXPIRED");
    if (quote.status !== "sent") throw ApiError.conflict("This quotation cannot be accepted now", "QUOTE_NOT_SENT");
    const version = await QuoteVersion.findByPk(quote.current_version_id, { include: [{ model: QuoteItem, as: "items" }], transaction });
    const address = await orderService().ownedAddress(auth, addressId, transaction);
    const company = quote.company_id ? await Company.findByPk(quote.company_id, { transaction }) : null;
    const seller = await settingsService.get("seller");
    const interstate = address.state.trim().toLowerCase() !== seller.state.trim().toLowerCase();

    // Payment terms: quoted terms, but credit only for approved accounts.
    let terms = version.payment_terms;
    if (["credit_15", "credit_30"].includes(terms) && !company?.credit_approved) terms = "advance_50";

    // Recompute the GST split for the actual place of supply (the totals stay as quoted).
    let cgst = 0;
    let sgst = 0;
    let igst = 0;
    const requestItems = await QuoteRequestItem.findAll({ where: { quote_id: quote.id }, transaction });
    const order = await Order.create(
      {
        order_number: await nextNumber("order", transaction),
        user_id: auth.user.id,
        company_id: quote.company_id,
        quote_id: quote.id,
        channel: quote.company_id ? "b2b" : "b2c",
        // A sales order: staff confirm it before payment is requested (flow step 3).
        status: "pending_confirmation",
        confirmation_status: "pending",
        payment_status: "pending",
        payment_terms: terms,
        approval_status: "not_required",
        subtotal_paise: version.subtotal_paise,
        setup_fees_paise: version.setup_fees_paise,
        discount_paise: version.discount_paise,
        shipping_paise: version.shipping_paise + version.packaging_paise,
        tax_paise: version.tax_paise,
        total_paise: version.total_paise,
        shipping_address: orderService().addressSnapshot(address),
        billing_address: orderService().addressSnapshot(address),
        gstin: gstin || company?.gstin || null,
        po_number: poNumber || null,
        deliver_by: quote.deadline,
        recipients: quote.recipients || [],
        notes: `Converted from quotation ${quote.quote_number} v${version.version_no}`,
      },
      { transaction }
    );
    let lineNo = 0;
    for (const qi of version.items) {
      const product = await Product.findByPk(qi.product_id, { transaction });
      const variant = qi.variant_id
        ? await ProductVariant.findByPk(qi.variant_id, { transaction })
        : await ProductVariant.findOne({ where: { product_id: product.id, is_active: true }, transaction });
      const request = requestItems.find((r) => r.id === qi.request_item_id);
      const tax = engine.gst(qi.line_total_paise, Number(qi.gst_rate), interstate);
      cgst += tax.cgst;
      sgst += tax.sgst;
      igst += tax.igst;
      const subtotalLine = qi.unit_price_paise * qi.quantity;
      await OrderItem.create(
        {
          order_id: order.id,
          line_no: ++lineNo,
          product_id: product.id,
          variant_id: variant.id,
          method_id: qi.method_id,
          design_version_id: request?.design_version_id || null,
          product_snapshot: {
            name: qi.description,
            slug: product.slug,
            sku: variant.sku,
            attributes: variant.attributes,
            image: variant.image || (product.images || [])[0],
            artworkAssetIds: request?.artwork_asset_ids || [],
            artworkNotes: request?.notes || null,
            quoteItemId: qi.id,
          },
          quantity: qi.quantity,
          size_breakdown: qi.size_breakdown,
          print_area_count: request?.print_area_count ?? 1,
          unit_price_paise: qi.unit_price_paise,
          setup_fee_paise: qi.setup_fee_paise,
          line_subtotal_paise: subtotalLine,
          discount_paise: subtotalLine - qi.line_total_paise,
          taxable_paise: qi.line_total_paise,
          hsn_code: qi.hsn_code,
          gst_rate: qi.gst_rate,
          tax_paise: tax.total,
          line_total_paise: qi.line_total_paise + tax.total,
          unit_cost_paise: 0,
          requires_proof: (request?.print_area_count ?? 1) > 0,
          state: "placed",
        },
        { transaction }
      );
    }
    await order.update({ cgst_paise: cgst, sgst_paise: sgst, igst_paise: igst }, { transaction });
    await quote.update({ status: "converted", order_id: order.id }, { transaction });
    await recordEvent(quote, { actorId: auth.user.id, role: "customer", event: "converted", from: "sent", to: "converted", versionNo: version.version_no, reason: `Order ${order.order_number}` }, transaction);
    await orderService().event(order.id, null, "order_placed", { actorId: auth.user.id, note: `Sales order created from quotation ${quote.quote_number}; waiting for confirmation`, transaction });
    transaction.afterCommit(() =>
      notifyQuoteTeam({ type: "quote_accepted", title: `${quote.quote_number} accepted`, body: `Sales order ${order.order_number} is waiting for your confirmation`, link: `/admin/orders/${order.id}` }).catch(() => {})
    );
    return { quote, orderId: order.id, orderNumber: order.order_number };
  });
}

async function postMessage(auth, id, { body }) {
  const quote = await loadVisible(auth, id);
  const message = await QuoteMessage.create({ quote_id: quote.id, user_id: auth.user.id, body });
  const staff = auth.permissions.has("quotes.view");
  if (staff) {
    await notificationService.notify(quote.requester_user_id, { type: "quote_message", title: `New message on ${quote.quote_number}`, body, link: `/${quote.company_id ? "business/" : ""}quotations/${quote.id}` });
  } else {
    await notifyQuoteTeam({ type: "quote_message", title: `Message on ${quote.quote_number}`, body, link: `/admin/quotations/${quote.id}` });
  }
  return message;
}

// Repeat order: a new request pre-filled from an earlier quotation.
async function repeat(auth, id) {
  const original = await loadVisible(auth, id);
  const items = await QuoteRequestItem.findAll({ where: { quote_id: original.id } });
  return create(auth, {
    title: `Repeat of ${original.quote_number}: ${original.title}`.slice(0, 200),
    deliveryLocations: original.delivery_locations,
    deliveryPincode: original.delivery_pincode,
    notes: original.notes,
    recipients: original.recipients,
    repeatOf: original.id,
    items: items.map((i) => ({
      productId: i.product_id,
      variantId: i.variant_id,
      methodId: i.method_id,
      quantity: i.quantity,
      sizeBreakdown: i.size_breakdown,
      printAreaCount: i.print_area_count,
      artworkAssetIds: i.artwork_asset_ids,
      designVersionId: i.design_version_id,
      notes: i.notes,
    })),
  });
}

async function expireDue() {
  const today = new Date().toISOString().slice(0, 10);
  const [rows] = await sequelize.query(
    `WITH due AS (
       SELECT q.id, q.status AS old_status, v.version_no
         FROM quotes q JOIN quote_versions v ON v.id = q.current_version_id
        WHERE q.status IN ('sent','revision_requested') AND v.valid_until < :today
          FOR UPDATE OF q
     )
     UPDATE quotes q SET status = 'expired', updated_at = now()
       FROM due WHERE q.id = due.id
      RETURNING q.id, q.quote_number, q.requester_user_id, q.company_id, q.request_revision, due.old_status, due.version_no`,
    { replacements: { today } }
  );
  for (const r of rows) {
    await QuoteEvent.create({ quote_id: r.id, actor_role: "system", event: "expired", from_status: r.old_status, to_status: "expired", request_revision: r.request_revision || 1, version_no: r.version_no });
    await notificationService.notify(r.requester_user_id, { type: "quote_expired", title: `Quotation ${r.quote_number} expired`, body: "Ask us to revise it if you still need these items.", link: `/${r.company_id ? "business/" : ""}quotations/${r.id}` });
  }
  return rows.length;
}

module.exports = {
  create,
  list,
  detail,
  suggest,
  sendVersion,
  markUnderReview,
  requestRevision,
  reject,
  returnToCustomer,
  decline,
  resubmit,
  history,
  document,
  accept,
  postMessage,
  repeat,
  expireDue,
  CATEGORY_LABELS,
};
