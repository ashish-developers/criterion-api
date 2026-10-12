// Organisation user management endpoints, shared by the company, vendor and platform scopes.
const svc = require("../Services/userAdminService");
const { ok, created, pageParams, pageMeta } = require("../Utils/http");

function forScope(scope) {
  return {
    list: async (req, res) => {
      const paging = pageParams(req.validatedQuery);
      const result = await svc.list(req.auth, scope, { ...req.validatedQuery, ...paging });
      return ok(res, result.items, "OK", pageMeta(paging, result.total));
    },
    exportCsv: async (req, res) => {
      const csv = await svc.exportCsv(req.auth, scope, req.validatedQuery || {});
      res.setHeader("Content-Type", "text/csv; charset=utf-8");
      res.setHeader("Content-Disposition", `attachment; filename="users-${new Date().toISOString().slice(0, 10)}.csv"`);
      res.setHeader("Cache-Control", "no-store");
      return res.send(csv);
    },
    validateRows: async (req, res) => ok(res, await svc.validateRows(req.auth, scope, req.body.rows)),
    bulkCreate: async (req, res) => {
      const result = await svc.createBulk(req, scope, req.body);
      const message = result.replayed ? "This request was already processed" : `${result.created} of ${result.total} users created`;
      return result.replayed ? ok(res, result, message) : created(res, result, message);
    },
    batch: async (req, res) => ok(res, await svc.getBatch(req.auth, scope, req.params.batchId)),
    update: async (req, res) => ok(res, await svc.update(req, scope, req.params.id, req.body), "User updated"),
    status: async (req, res) => ok(res, await svc.setActive(req, scope, req.params.id, req.body.active), req.body.active ? "User activated" : "User deactivated"),
    resend: async (req, res) => ok(res, await svc.resendInvite(req, scope, req.params.id), "Invitation queued"),
  };
}

module.exports = { forScope };
