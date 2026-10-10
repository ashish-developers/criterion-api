// Response and pagination helpers so every endpoint returns the same envelope:
//   { status: true, message, data, meta? }
function ok(res, data, message = "OK", meta) {
  const body = { status: true, message, data };
  if (meta) body.meta = meta;
  return res.status(200).json(body);
}

function created(res, data, message = "Created") {
  return res.status(201).json({ status: true, message, data });
}

function pageParams(query, { defaultLimit = 20, maxLimit = 100 } = {}) {
  const page = Math.max(1, parseInt(query.page, 10) || 1);
  const limit = Math.min(maxLimit, Math.max(1, parseInt(query.limit, 10) || defaultLimit));
  return { page, limit, offset: (page - 1) * limit };
}

function pageMeta({ page, limit }, total) {
  return { page, limit, total, totalPages: Math.max(1, Math.ceil(total / limit)) };
}

function clientIp(req) {
  return (req.ip || req.socket?.remoteAddress || "").slice(0, 64);
}

module.exports = { ok, created, pageParams, pageMeta, clientIp };
