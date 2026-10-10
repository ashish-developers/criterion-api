const companyService = require("../Services/companyService");
const auditService = require("../Services/auditService");
const { sequelize } = require("../Models");
const { ok, created } = require("../Utils/http");

module.exports = {
  dashboard: async (req, res) => {
    const companyId = req.auth.companyId;
    const [[orders]] = await sequelize.query(
      `SELECT count(*)::int AS orders,
              count(*) FILTER (WHERE status NOT IN ('completed','delivered','cancelled','refunded'))::int AS open_orders,
              COALESCE(sum(total_paise) FILTER (WHERE status NOT IN ('cancelled','refunded') AND placed_at > date_trunc('year', now())),0)::bigint AS spend_ytd,
              count(*) FILTER (WHERE approval_status = 'pending')::int AS awaiting_approval,
              COALESCE(sum(total_paise - amount_paid_paise) FILTER (WHERE status NOT IN ('cancelled','refunded')),0)::bigint AS outstanding
         FROM orders WHERE company_id = :companyId`,
      { replacements: { companyId } }
    );
    const [[quotes]] = await sequelize.query(
      `SELECT count(*) FILTER (WHERE status IN ('requested','under_review','revision_requested'))::int AS pending,
              count(*) FILTER (WHERE status = 'sent')::int AS to_review
         FROM quotes WHERE company_id = :companyId`,
      { replacements: { companyId } }
    );
    const [[proofs]] = await sequelize.query(
      `SELECT count(*)::int AS waiting FROM order_items oi JOIN orders o ON o.id = oi.order_id WHERE o.company_id = :companyId AND oi.state = 'proof_sent'`,
      { replacements: { companyId } }
    );
    const [recent] = await sequelize.query(
      `SELECT o.id, o.order_number, o.status, o.total_paise, o.placed_at, o.po_number, u.name AS placed_by
         FROM orders o JOIN users u ON u.id = o.user_id WHERE o.company_id = :companyId ORDER BY o.placed_at DESC LIMIT 6`,
      { replacements: { companyId } }
    );
    const [monthly] = await sequelize.query(
      `SELECT to_char(m, 'Mon') AS month, COALESCE(sum(o.total_paise),0)::bigint AS spend
         FROM generate_series(date_trunc('month', now()) - interval '5 months', date_trunc('month', now()), interval '1 month') m
         LEFT JOIN orders o ON o.company_id = :companyId AND date_trunc('month', o.placed_at) = m AND o.status NOT IN ('cancelled','refunded')
        GROUP BY m ORDER BY m`,
      { replacements: { companyId } }
    );
    return ok(res, {
      orders: { total: orders.orders, open: orders.open_orders, spendYtdPaise: Number(orders.spend_ytd), awaitingApproval: orders.awaiting_approval, outstandingPaise: Number(orders.outstanding) },
      quotes,
      proofsWaiting: proofs.waiting,
      recentOrders: recent,
      monthlySpend: monthly.map((m) => ({ month: m.month, spendPaise: Number(m.spend) })),
    });
  },
  profile: async (req, res) => ok(res, await companyService.profile(req.auth)),
  updateProfile: async (req, res) => {
    const result = await companyService.update(req.auth, req.body);
    await auditService.record(req, "company.updated", "company", req.auth.companyId, { after: req.body });
    return ok(res, result, "Company profile updated");
  },
  team: async (req, res) => ok(res, await companyService.team(req.auth)),
  invite: async (req, res) => created(res, await companyService.invite(req.auth, req.body), "Team member added"),
  updateMember: async (req, res) => ok(res, await companyService.updateMember(req.auth, Number(req.params.id), req.body), req.body.remove ? "Team member removed" : "Role updated"),
  brandKits: async (req, res) => ok(res, await companyService.brandKits(req.auth)),
  createBrandKit: async (req, res) => created(res, await companyService.saveBrandKit(req.auth, req.body), "Brand kit saved"),
  updateBrandKit: async (req, res) => ok(res, await companyService.saveBrandKit(req.auth, req.body, req.params.id), "Brand kit updated"),
  deleteBrandKit: async (req, res) => {
    await companyService.deleteBrandKit(req.auth, req.params.id);
    return ok(res, null, "Brand kit deleted");
  },
  invoices: async (req, res) => ok(res, await companyService.invoices(req.auth)),
  purchaseOrders: async (req, res) => ok(res, await companyService.purchaseOrders(req.auth)),
};
