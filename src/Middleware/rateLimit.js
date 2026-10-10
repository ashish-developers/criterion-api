// In-memory fixed-window rate limiter. Good for a single API instance; swap the store
// for Redis when running several instances behind a load balancer.
const ApiError = require("../Utils/ApiError");
const { clientIp } = require("../Utils/http");

const buckets = new Map();

setInterval(() => {
  const now = Date.now();
  for (const [key, bucket] of buckets) if (bucket.resetAt <= now) buckets.delete(key);
}, 60_000).unref();

function hit(key, windowMs) {
  const now = Date.now();
  let bucket = buckets.get(key);
  if (!bucket || bucket.resetAt <= now) {
    bucket = { count: 0, resetAt: now + windowMs };
    buckets.set(key, bucket);
  }
  bucket.count += 1;
  return bucket;
}

/**
 * rateLimit({ name, windowMs, max, by: (req) => extraKey })
 */
function rateLimit({ name, windowMs = 60_000, max = 60, by }) {
  return (req, res, next) => {
    const extra = by ? by(req) : "";
    const key = `${name}:${clientIp(req)}:${extra}`;
    const bucket = hit(key, windowMs);
    res.setHeader("RateLimit-Limit", max);
    res.setHeader("RateLimit-Remaining", Math.max(0, max - bucket.count));
    if (bucket.count > max) {
      const retryAfter = Math.ceil((bucket.resetAt - Date.now()) / 1000);
      res.setHeader("Retry-After", retryAfter);
      return next(ApiError.tooMany(undefined, retryAfter));
    }
    next();
  };
}

function resetRateLimits() {
  buckets.clear();
}

module.exports = { rateLimit, resetRateLimits };
