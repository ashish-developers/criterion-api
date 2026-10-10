// Request-for-quote workflow (Section 7.4, FR-BB-02/03):
// requested -> (under_review) -> sent -> revision_requested -> sent (new version) ...
//           -> accepted -> converted to an order at the quoted prices | rejected | expired.
const { Op } = require("sequelize");
const {
  sequelize,
  Quote,
  QuoteRequestItem,
  QuoteVersion,
  QuoteItem,
  QuoteMessage,
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
    await quote.update({ status: "expired" }, { transaction });
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
      { model: QuoteVersion, as: "currentVersion", attributes: ["id", "version_no", "total_paise", "valid_until"] },
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
  return { items: rows.map((r) => ({ ...r.toJSON(), lines: byId.get(r.id)?.lines || 0, units: byId.get(r.id)?.units || 0 })), total: count };
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
  return {
    ...quote.toJSON(),
    requester,
    company,
    requestItems: requestItems.map((i) => ({ ...i.toJSON(), artwork: i.artwork_asset_ids.map((a) => byId.get(a)).filter(Boolean) })),
    versions: visibleVersions,
    currentVersion: current && (staff || current.sent_at) ? current : null,
    messages: messages.map((m) => ({ id: m.id, body: m.body, user: m.user?.name, isMine: m.user_id === auth.user.id, at: m.created_at })),
    actions: {
      canAccept: ["sent"].includes(quote.status) && quote.requester_user_id === auth.user.id,
      canRequestRevision: ["sent"].includes(quote.status) && (quote.requester_user_id === auth.user.id || quote.company_id === auth.companyId),
      canReject: ["sent", "revision_requested"].includes(quote.status) && quote.requester_user_id === auth.user.id,
      canPrice: auth.permissions.has("quotes.manage") && ["requested", "under_review", "revision_requested", "sent", "expired"].includes(quote.status),
    },
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
    if (!["requested", "under_review", "revision_requested", "sent", "expired"].includes(quote.status)) {
      throw ApiError.conflict(`A ${quote.status} quotation cannot be re-priced`, "QUOTE_CLOSED");
    }
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
    await notificationService.notify(
      quote.requester_user_id,
      { type: "quote_sent", title: `Quotation ${quote.quote_number} ${versionNo > 1 ? "revised" : "ready"}`, body: `Total ₹${(version.total_paise / 100).toFixed(2)}, valid until ${validUntil}.`, link: `/${quote.company_id ? "business/" : ""}quotations/${quote.id}` },
      { transaction }
    );
    return version;
  });
}

async function markUnderReview(auth, id) {
  const quote = await loadVisible(auth, id);
  if (quote.status !== "requested") return quote;
  return quote.update({ status: "under_review", assigned_admin_id: auth.user.id, first_response_at: quote.first_response_at || new Date() });
}

async function requestRevision(auth, id, { comment }) {
  return sequelize.transaction(async (transaction) => {
    const quote = await expireIfDue(await loadVisible(auth, id, { transaction, lock: true }), transaction);
    if (quote.status !== "sent") throw ApiError.conflict("This quotation cannot be revised now", "QUOTE_NOT_SENT");
    await quote.update({ status: "revision_requested" }, { transaction });
    await QuoteMessage.create({ quote_id: quote.id, user_id: auth.user.id, body: `Revision requested: ${comment}` }, { transaction });
    transaction.afterCommit(() => notifyQuoteTeam({ type: "quote_revision", title: `Revision requested on ${quote.quote_number}`, body: comment, link: `/admin/quotations/${quote.id}` }).catch(() => {}));
    return quote;
  });
}

async function reject(auth, id, { reason }) {
  return sequelize.transaction(async (transaction) => {
    const quote = await loadVisible(auth, id, { transaction, lock: true });
    if (quote.requester_user_id !== auth.user.id) throw ApiError.forbidden();
    if (!["sent", "revision_requested"].includes(quote.status)) throw ApiError.conflict("This quotation cannot be rejected now", "QUOTE_CLOSED");
    await quote.update({ status: "rejected" }, { transaction });
    if (reason) await QuoteMessage.create({ quote_id: quote.id, user_id: auth.user.id, body: `Rejected: ${reason}` }, { transaction });
    return quote;
  });
}

/** Accepting converts the quote into an order at the quoted prices (no repricing). */
async function accept(auth, id, { addressId, poNumber, gstin }) {
  return sequelize.transaction(async (transaction) => {
    const quote = await expireIfDue(await loadVisible(auth, id, { transaction, lock: true }), transaction);
    if (quote.requester_user_id !== auth.user.id) throw ApiError.forbidden("Only the person who requested this quotation can accept it");
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
        status: "payment_pending",
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
          state: "payment_pending",
        },
        { transaction }
      );
    }
    await order.update({ cgst_paise: cgst, sgst_paise: sgst, igst_paise: igst }, { transaction });
    await quote.update({ status: "converted", order_id: order.id }, { transaction });
    await orderService().event(order.id, null, "order_placed", { actorId: auth.user.id, note: `Created from quotation ${quote.quote_number}`, transaction });
    await orderService().advanceAfterPayment(order.id, { actorId: auth.user.id, transaction });
    transaction.afterCommit(() => notifyQuoteTeam({ type: "quote_accepted", title: `${quote.quote_number} accepted`, body: `Order ${order.order_number} created`, link: `/admin/orders/${order.id}` }).catch(() => {}));
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
    `UPDATE quotes q SET status = 'expired', updated_at = now()
       FROM quote_versions v
      WHERE v.id = q.current_version_id AND q.status IN ('sent','revision_requested') AND v.valid_until < :today
      RETURNING q.id, q.quote_number, q.requester_user_id, q.company_id`,
    { replacements: { today } }
  );
  for (const r of rows) {
    await notificationService.notify(r.requester_user_id, { type: "quote_expired", title: `Quotation ${r.quote_number} expired`, body: "Ask us to revise it if you still need these items.", link: `/${r.company_id ? "business/" : ""}quotations/${r.id}` });
  }
  return rows.length;
}

module.exports = { create, list, detail, suggest, sendVersion, markUnderReview, requestRevision, reject, accept, postMessage, repeat, expireDue };
