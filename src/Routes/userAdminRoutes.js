// Mounts the user management endpoints for one scope behind the given guard middleware.
const { validate } = require("../Middleware/validate");
const { rateLimit } = require("../Middleware/rateLimit");
const v = require("../Validators/userAdminValidators");
const { forScope } = require("../Controllers/userAdminController");

function mountUserAdmin(router, path, scope, guards) {
  const c = forScope(scope);
  const bulkLimit = rateLimit({ name: `users-bulk-${scope}`, windowMs: 60 * 60 * 1000, max: 60, by: (req) => req.auth?.user?.id });
  router.get(`${path}`, ...guards, validate({ query: v.list }), c.list);
  router.get(`${path}/export`, ...guards, validate({ query: v.list }), c.exportCsv);
  router.post(`${path}/validate`, ...guards, validate({ body: v.validateRows }), c.validateRows);
  router.post(`${path}/bulk`, ...guards, bulkLimit, validate({ body: v.bulkCreate }), c.bulkCreate);
  router.get(`${path}/batches/:batchId`, ...guards, validate({ params: v.batchId }), c.batch);
  router.patch(`${path}/:id`, ...guards, validate({ params: v.userId, body: v.update }), c.update);
  router.post(`${path}/:id/status`, ...guards, validate({ params: v.userId, body: v.status }), c.status);
  router.post(`${path}/:id/resend-invite`, ...guards, validate({ params: v.userId }), c.resend);
}

module.exports = { mountUserAdmin };
