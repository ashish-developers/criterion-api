// Customer support (FR-SU-01..03): a ticket per order with history and attachments,
// change requests until proof approval, and the complaint flow:
// photo evidence -> decision (reprint, replace, refund, reject) -> liability.
//
// Assignment: staff with tickets.manage work on tickets assigned to them and can pick up
// unassigned ones; tickets.assign lets someone (the Platform Admin) assign or reassign any
// ticket to any support team member; tickets.view_all shows tickets assigned to others.
// Every change is kept in ticket_assignments and noted on the ticket's internal timeline.
const { Op } = require("sequelize");
const { sequelize, Ticket, TicketMessage, TicketAssignment, Order, OrderItem, User, Commission, Proof, ProductionJob } = require("../Models");
const ApiError = require("../Utils/ApiError");
const { nextNumber } = require("../Utils/numbering");
const settingsService = require("./settingsService");
const notificationService = require("./notificationService");
const assetService = require("./assetService");

const orderService = () => require("./orderService");

const PRE_APPROVAL = ["placed", "payment_pending", "artwork_pending", "proof_sent"];

async function create(auth, { orderId, orderItemId, type, subject, message, attachmentAssetIds = [] }) {
  return sequelize.transaction(async (transaction) => {
    let order = null;
    let item = null;
    if (orderId) {
      order = await orderService().loadVisible(auth, orderId, { transaction });
      if (order.user_id !== auth.user.id && order.company_id !== auth.companyId) throw ApiError.forbidden();
    }
    if (orderItemId) {
      item = await OrderItem.findByPk(orderItemId, { transaction });
      if (!item || !order || item.order_id !== order.id) throw ApiError.unprocessable("Choose an item from this order", "ITEM_INVALID");
    }
    if (attachmentAssetIds.length) await assetService.assertUsable(auth, attachmentAssetIds);

    if (type === "change_request") {
      if (!item) throw ApiError.unprocessable("Choose the item you want to change", "ITEM_REQUIRED");
      if (!PRE_APPROVAL.includes(item.state)) throw ApiError.conflict("Changes are only possible until the proof is approved", "CHANGE_WINDOW_CLOSED");
    }
    if (type === "complaint") {
      if (!item) throw ApiError.unprocessable("Choose the item with the problem", "ITEM_REQUIRED");
      const { complaint_window_days: days } = await settingsService.get("orders");
      if (item.state !== "delivered" || !item.delivered_at) throw ApiError.conflict("Complaints can be raised once the item is delivered", "NOT_DELIVERED");
      if (Date.now() - item.delivered_at.getTime() > days * 86400 * 1000) throw ApiError.conflict(`Complaints must be raised within ${days} days of delivery`, "COMPLAINT_WINDOW_CLOSED");
      if (!attachmentAssetIds.length) throw ApiError.unprocessable("Add at least one photo showing the problem", "PHOTO_REQUIRED");
    }
    const ticket = await Ticket.create(
      {
        ticket_number: await nextNumber("ticket", transaction),
        user_id: auth.user.id,
        order_id: order?.id || null,
        order_item_id: item?.id || null,
        type,
        subject,
        priority: type === "complaint" ? "high" : "normal",
      },
      { transaction }
    );
    await TicketMessage.create({ ticket_id: ticket.id, user_id: auth.user.id, body: message, attachment_asset_ids: attachmentAssetIds }, { transaction });
    if (order) await orderService().event(order.id, item?.id || null, "ticket_opened", { actorId: auth.user.id, note: `${ticket.ticket_number}: ${subject}`, transaction });
    transaction.afterCommit(() =>
      require("./productionService").notifyStaff("tickets.manage", { type: "ticket_opened", title: `${ticket.ticket_number}: ${subject}`, body: type.replace("_", " "), link: `/admin/support/${ticket.id}` }).catch(() => {})
    );
    return ticket;
  });
}

const ACTIVE = ["open", "in_progress", "awaiting_customer"];
const PERSON = ["id", "name", "email", "avatar_url"];

const isStaff = (auth) => auth.permissions.has("tickets.manage");
const seesAll = (auth) => auth.permissions.has("tickets.view_all") || auth.permissions.has("tickets.assign");

// Staff see their own tickets and the unassigned queue; tickets.view_all (or tickets.assign) shows all.
function staffCanSee(auth, ticket) {
  return isStaff(auth) && (seesAll(auth) || !ticket.assigned_to || ticket.assigned_to === auth.user.id);
}

async function loadVisible(auth, id, options) {
  const ticket = await Ticket.findByPk(id, options);
  if (!ticket) throw ApiError.notFound("Ticket not found");
  if (ticket.user_id !== auth.user.id && !staffCanSee(auth, ticket)) throw ApiError.notFound("Ticket not found");
  return ticket;
}

/**
 * Active platform users who may work on tickets (tickets.manage through a platform role or an
 * individual grant), with how many open tickets each holds. Pass an id to check just one.
 */
async function eligibleAssignees(id) {
  const [rows] = await sequelize.query(
    `SELECT u.id, u.name, u.email, u.avatar_url,
            (SELECT count(*) FROM tickets t WHERE t.assigned_to = u.id AND t.status IN (:active))::int AS open_tickets
       FROM users u
      WHERE u.status = 'active' AND u.deleted_at IS NULL
        ${id ? "AND u.id = :id" : ""}
        AND EXISTS (SELECT 1 FROM user_roles ur WHERE ur.user_id = u.id AND ur.scope_type = 'platform')
        AND (EXISTS (SELECT 1 FROM user_roles ur JOIN role_permissions rp ON rp.role_id = ur.role_id JOIN permissions p ON p.id = rp.permission_id
                      WHERE ur.user_id = u.id AND ur.scope_type = 'platform' AND p.code = 'tickets.manage')
          OR EXISTS (SELECT 1 FROM user_permissions up JOIN permissions p ON p.id = up.permission_id
                      WHERE up.user_id = u.id AND p.code = 'tickets.manage'))
      ORDER BY u.name`,
    { replacements: { active: ACTIVE, id: id || null } }
  );
  return rows.map((r) => ({ id: r.id, name: r.name, email: r.email, avatarUrl: r.avatar_url, openTickets: r.open_tickets }));
}

/**
 * Staff inbox and customer "my tickets". Filters: status, type, priority, assignedTo
 * ("me", "unassigned" or a user id), q (number, subject, customer) and from/to (created date).
 */
async function list(auth, { scope = "mine", status, type, priority, assignedTo, q, from, to, page = 1, limit = 20 }) {
  const where = {};
  const and = [];
  if (scope === "all") {
    if (!isStaff(auth)) throw ApiError.forbidden();
    if (!seesAll(auth)) and.push({ [Op.or]: [{ assigned_to: auth.user.id }, { assigned_to: null }] });
  } else where.user_id = auth.user.id;
  if (status) where.status = status.includes(",") ? { [Op.in]: status.split(",") } : status;
  if (type) where.type = type;
  if (priority) where.priority = priority;
  if (assignedTo === "me") where.assigned_to = auth.user.id;
  else if (assignedTo === "unassigned") where.assigned_to = null;
  else if (assignedTo) {
    if (!seesAll(auth) && assignedTo !== auth.user.id) throw ApiError.forbidden("You can only see tickets assigned to you or not yet assigned");
    where.assigned_to = assignedTo;
  }
  if (from || to) {
    where.created_at = {};
    if (from) where.created_at[Op.gte] = new Date(`${from}T00:00:00+05:30`);
    if (to) where.created_at[Op.lt] = new Date(new Date(`${to}T00:00:00+05:30`).getTime() + 86400 * 1000);
  }
  if (q) {
    const term = `%${q.replace(/[%_\\]/g, "\\$&")}%`;
    and.push({ [Op.or]: [{ ticket_number: { [Op.iLike]: term } }, { subject: { [Op.iLike]: term } }, { "$user.name$": { [Op.iLike]: term } }, { "$user.email$": { [Op.iLike]: term } }] });
  }
  if (and.length) where[Op.and] = and;
  const { rows, count } = await Ticket.findAndCountAll({
    where,
    include: [
      { model: User, as: "user", attributes: ["id", "name", "email"] },
      { model: Order, as: "order", attributes: ["id", "order_number"] },
      { model: User, as: "assignee", attributes: PERSON },
    ],
    order: [["updated_at", "DESC"]],
    limit,
    offset: (page - 1) * limit,
    subQuery: false,
  });
  return { items: rows, total: count };
}

/**
 * Moves a ticket to another assignee (or none) and records it: a history row and an internal
 * note on the timeline. Returns the people to notify once the transaction commits.
 */
async function applyAssignment(ticket, { to, by, note, transaction }) {
  const from = ticket.assigned_to || null;
  if ((to || null) === from) return null;
  const users = await User.findAll({ where: { id: [from, to, by].filter(Boolean) }, attributes: ["id", "name"], transaction });
  const name = (id) => users.find((u) => u.id === id)?.name || "a team member";
  await ticket.update({ assigned_to: to || null }, { transaction });
  await TicketAssignment.create({ ticket_id: ticket.id, from_user_id: from, to_user_id: to || null, assigned_by: by, note: note || null }, { transaction });
  const text = !to ? `Unassigned (was ${name(from)}).` : from ? `Reassigned from ${name(from)} to ${name(to)}.` : to === by ? `${name(to)} picked up this ticket.` : `Assigned to ${name(to)}.`;
  await TicketMessage.create({ ticket_id: ticket.id, user_id: by, body: note ? `${text} Note: ${note}` : text, is_internal: true }, { transaction });
  return { from, to: to || null, by, byName: name(by), toName: to ? name(to) : null };
}

function notifyAssignment(ticket, change) {
  if (!change) return Promise.resolve();
  const link = `/admin/support/${ticket.id}`;
  const jobs = [];
  if (change.to && change.to !== change.by) {
    jobs.push(notificationService.notify(change.to, { type: "ticket_assigned", title: `${ticket.ticket_number} assigned to you`, body: `${change.byName} assigned you "${ticket.subject}".`, link }));
  }
  if (change.from && change.from !== change.by && change.from !== change.to) {
    jobs.push(
      notificationService.notify(change.from, {
        type: "ticket_reassigned",
        title: `${ticket.ticket_number} ${change.to ? "reassigned" : "unassigned"}`,
        body: change.to ? `${change.byName} reassigned "${ticket.subject}" to ${change.toName}.` : `${change.byName} removed you from "${ticket.subject}".`,
        link,
        email: false,
      })
    );
  }
  return Promise.all(jobs);
}

/**
 * Assigns, reassigns or unassigns a ticket (assigneeId null). tickets.assign may choose any
 * eligible team member; other staff may only pick up an unassigned ticket for themselves.
 */
async function assign(auth, id, { assigneeId, note }) {
  if (!isStaff(auth) && !auth.permissions.has("tickets.assign")) throw ApiError.forbidden();
  const result = await sequelize.transaction(async (transaction) => {
    const ticket = await Ticket.findByPk(id, { transaction, lock: transaction.LOCK.UPDATE });
    if (!ticket || !(auth.permissions.has("tickets.assign") || staffCanSee(auth, ticket))) throw ApiError.notFound("Ticket not found");
    if (!auth.permissions.has("tickets.assign") && (assigneeId !== auth.user.id || ticket.assigned_to)) {
      throw ApiError.forbidden("Only a support manager can assign tickets to other team members or take over an assigned ticket", "ASSIGN_FORBIDDEN");
    }
    if (assigneeId && !(await eligibleAssignees(assigneeId)).length) {
      throw ApiError.unprocessable("Choose an active support team member", "ASSIGNEE_INVALID", { assigneeId: "Not an active support team member" });
    }
    const change = await applyAssignment(ticket, { to: assigneeId, by: auth.user.id, note, transaction });
    return { ticket, change };
  });
  await notifyAssignment(result.ticket, result.change).catch((error) => console.error(`Ticket assignment notification failed: ${error.message}`));
  const ticket = await Ticket.findByPk(id, { include: [{ model: User, as: "assignee", attributes: PERSON }] });
  return { ticket, changed: Boolean(result.change), previous: result.change?.from ?? ticket.assigned_to };
}

async function assignmentHistory(ticketId) {
  const rows = await TicketAssignment.findAll({
    where: { ticket_id: ticketId },
    include: [
      { model: User, as: "fromUser", attributes: ["id", "name"] },
      { model: User, as: "toUser", attributes: ["id", "name"] },
      { model: User, as: "assignedBy", attributes: ["id", "name"] },
    ],
    order: [["created_at", "DESC"]],
  });
  return rows.map((r) => ({ id: r.id, from: r.fromUser, to: r.toUser, by: r.assignedBy, note: r.note, at: r.created_at }));
}

async function detail(auth, id) {
  const ticket = await loadVisible(auth, id);
  const staff = staffCanSee(auth, ticket);
  const messages = await TicketMessage.findAll({
    where: { ticket_id: ticket.id, ...(staff ? {} : { is_internal: false }) },
    include: [{ model: User, as: "user", attributes: ["id", "name"] }],
    order: [["created_at", "ASC"]],
  });
  const [order, item, user] = await Promise.all([
    ticket.order_id ? Order.findByPk(ticket.order_id, { attributes: ["id", "order_number", "status", "amount_paid_paise", "amount_refunded_paise"] }) : null,
    ticket.order_item_id ? OrderItem.findByPk(ticket.order_item_id) : null,
    User.findByPk(ticket.user_id, { attributes: ["id", "name", "email", "phone"] }),
  ]);
  const proofs = item ? await Proof.findAll({ where: { order_item_id: item.id }, order: [["version_no", "DESC"]] }) : [];
  const assignee = staff && ticket.assigned_to ? await User.findByPk(ticket.assigned_to, { attributes: PERSON }) : null;
  return {
    ...ticket.toJSON(),
    user: staff ? user : undefined,
    assignee,
    assignmentHistory: staff ? await assignmentHistory(ticket.id) : undefined,
    access: staff ? { canAssign: auth.permissions.has("tickets.assign"), canPickUp: !ticket.assigned_to } : undefined,
    order,
    item: item
      ? { id: item.id, name: item.product_snapshot.name, quantity: item.quantity, state: item.state, vendorId: staff ? item.vendor_id : undefined, fulfilmentSource: staff ? item.fulfilment_source : undefined, lineTotalPaise: item.line_total_paise }
      : null,
    proofs: proofs.map((p) => ({ id: p.id, versionNo: p.version_no, status: p.status, previewUrl: p.preview_asset_id ? `/api/v1/assets/${p.preview_asset_id}` : null })),
    messages: messages.map((m) => ({
      id: m.id,
      body: m.body,
      user: m.user?.name,
      isMine: m.user_id === auth.user.id,
      isInternal: m.is_internal,
      attachments: m.attachment_asset_ids.map((a) => `/api/v1/assets/${a}`),
      at: m.created_at,
    })),
  };
}

async function reply(auth, id, { body, attachmentAssetIds = [], internal = false }) {
  const ticket = await loadVisible(auth, id);
  const staff = staffCanSee(auth, ticket) && ticket.user_id !== auth.user.id;
  if (internal && !staff) throw ApiError.forbidden();
  if (attachmentAssetIds.length) await assetService.assertUsable(auth, attachmentAssetIds);
  if (["closed"].includes(ticket.status)) throw ApiError.conflict("This ticket is closed", "TICKET_CLOSED");
  const message = await TicketMessage.create({ ticket_id: ticket.id, user_id: auth.user.id, body, attachment_asset_ids: attachmentAssetIds, is_internal: Boolean(internal) });
  const nextStatus = staff ? (internal ? ticket.status : "awaiting_customer") : "open";
  await ticket.update({ status: nextStatus });
  // Replying to an unassigned ticket picks it up.
  if (staff && !ticket.assigned_to) await sequelize.transaction((transaction) => applyAssignment(ticket, { to: auth.user.id, by: auth.user.id, transaction }));
  if (staff && !internal) {
    await notificationService.notify(ticket.user_id, { type: "ticket_reply", title: `Reply on ${ticket.ticket_number}`, body, link: `/support/tickets/${ticket.id}` });
  }
  return message;
}

async function update(auth, id, { status, priority, assignedTo }) {
  // Assignment goes through the same checks, history and notifications as POST .../assign.
  if (assignedTo !== undefined) await assign(auth, id, { assigneeId: assignedTo });
  const ticket = await loadVisible(auth, id);
  if (!staffCanSee(auth, ticket)) throw ApiError.notFound("Ticket not found");
  await ticket.update({ status: status || ticket.status, priority: priority || ticket.priority, resolved_at: ["resolved", "closed"].includes(status) ? new Date() : ticket.resolved_at });
  return ticket;
}

/**
 * Complaint decision (FR-SU-03). Reprint/replace creates a linked zero-price order line that
 * reuses the approved proof and goes straight to production assignment. Vendor liability
 * is charged back on the vendor's next settlement.
 */
async function resolveComplaint(auth, id, { decision, liability, note, refundPaise }) {
  return sequelize.transaction(async (transaction) => {
    const ticket = await Ticket.findByPk(id, { transaction, lock: transaction.LOCK.UPDATE });
    if (!ticket || !staffCanSee(auth, ticket)) throw ApiError.notFound("Ticket not found");
    if (ticket.type !== "complaint") throw ApiError.conflict("Only complaints have a resolution decision", "NOT_A_COMPLAINT");
    if (ticket.decision) throw ApiError.conflict("This complaint has already been decided", "ALREADY_DECIDED");
    const item = await OrderItem.findByPk(ticket.order_item_id, { transaction, lock: transaction.LOCK.UPDATE });
    const order = await Order.findByPk(item.order_id, { transaction });
    let reprintItem = null;
    let refund = null;

    if (decision === "reprint" || decision === "replace") {
      const lineNo = ((await OrderItem.max("line_no", { where: { order_id: order.id }, transaction })) || 0) + 1;
      reprintItem = await OrderItem.create(
        {
          order_id: order.id,
          line_no: lineNo,
          product_id: item.product_id,
          variant_id: item.variant_id,
          method_id: item.method_id,
          design_version_id: item.design_version_id,
          product_snapshot: { ...item.product_snapshot, name: `${decision === "reprint" ? "Reprint" : "Replacement"}: ${item.product_snapshot.name}`, complaintTicket: ticket.ticket_number },
          quantity: item.quantity,
          size_breakdown: item.size_breakdown,
          print_area_count: item.print_area_count,
          unit_price_paise: 0,
          setup_fee_paise: 0,
          line_subtotal_paise: 0,
          taxable_paise: 0,
          hsn_code: item.hsn_code,
          gst_rate: item.gst_rate,
          tax_paise: 0,
          line_total_paise: 0,
          unit_cost_paise: item.unit_cost_paise,
          requires_proof: item.requires_proof,
          // The approved proof stays valid: production reuses that locked version.
          approved_proof_id: item.approved_proof_id,
          state: "proof_approved",
          reprint_of_item_id: item.id,
        },
        { transaction }
      );
      await orderService().event(order.id, reprintItem.id, "reprint_created", { actorId: auth.user.id, note: `${decision} for ${ticket.ticket_number}`, transaction });
      // The reopened order shows the replacement line in progress.
      if (order.status === "completed" || order.status === "delivered") await order.update({ closed_at: null }, { transaction });
      await orderService().refreshOrderStatus(order.id, transaction);
    } else if (decision === "refund") {
      const amount = refundPaise || item.line_total_paise;
      refund = await require("./refundService").createAndProcess(
        { order, amountPaise: Math.min(amount, order.amount_paid_paise - order.amount_refunded_paise), reason: `Complaint ${ticket.ticket_number}`, actorId: auth.user.id, autoApprove: auth.permissions.has("refunds.approve"), orderItemId: null, ticketId: ticket.id },
        { transaction }
      );
    }

    // Vendor bears reprint cost for production defects (Section 8.4).
    if (liability === "vendor" && item.vendor_id && decision !== "reject") {
      const job = await ProductionJob.findOne({ where: { order_item_id: item.id, vendor_id: item.vendor_id }, order: [["created_at", "DESC"]], transaction });
      const charge = decision === "refund" ? (refund?.amount_paise || 0) : job?.agreed_cost_paise || item.unit_cost_paise * item.quantity;
      const commission = await Commission.findOne({ where: { order_item_id: item.id }, transaction });
      if (commission && !commission.settlement_id) {
        await commission.update({ adjustment_paise: commission.adjustment_paise + charge }, { transaction });
      } else if (reprintItem) {
        // Already settled: carry the charge on the reprint line, deducted in the next cycle.
        await Commission.create(
          { order_item_id: reprintItem.id, vendor_id: item.vendor_id, model: commission?.model || "job_rate", item_value_paise: 0, commission_pct: 0, commission_paise: 0, vendor_earning_paise: 0, adjustment_paise: charge, eligible_at: new Date() },
          { transaction }
        );
      } else {
        await TicketMessage.create({ ticket_id: ticket.id, user_id: auth.user.id, is_internal: true, body: `Vendor charge-back of ₹${(charge / 100).toFixed(2)} needs a manual settlement adjustment (line already settled).` }, { transaction });
      }
      const { Vendor } = require("../Models");
      const vendor = await Vendor.findByPk(item.vendor_id, { transaction });
      await vendor.update({ quality_score: Math.max(1, Number(vendor.quality_score) - 0.1).toFixed(2) }, { transaction });
    }

    if (!ticket.assigned_to) await applyAssignment(ticket, { to: auth.user.id, by: auth.user.id, transaction });
    await ticket.update({ decision, liability, resolution_note: note, status: "resolved", resolved_at: new Date(), reprint_order_item_id: reprintItem?.id || null }, { transaction });
    await TicketMessage.create({ ticket_id: ticket.id, user_id: auth.user.id, body: `Decision: ${decision}. ${note || ""}`.trim() }, { transaction });
    await notificationService.notify(
      ticket.user_id,
      { type: "complaint_resolved", title: `${ticket.ticket_number} resolved`, body: { reprint: "We will reprint your item free of charge.", replace: "We will send a replacement free of charge.", refund: "Your refund has been initiated.", reject: note || "We could not accept this complaint." }[decision], link: `/support/tickets/${ticket.id}` },
      { transaction }
    );
    return { ticket, reprintItemId: reprintItem?.id || null, refund };
  });
}

async function countOpen() {
  return Ticket.count({ where: { status: { [Op.in]: ["open", "in_progress"] } } });
}

module.exports = { create, list, detail, reply, update, assign, eligibleAssignees, resolveComplaint, countOpen };
