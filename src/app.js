const express = require("express");
const helmet = require("helmet");
const cors = require("cors");
const cookieParser = require("cookie-parser");
const { config } = require("./Config/env");
const routes = require("./Routes");
const { csrfProtection } = require("./Middleware/csrf");
const { notFound, errorHandler } = require("./Middleware/errorHandler");

function createApp() {
  const app = express();
  app.disable("x-powered-by");
  if (config.trustProxy) app.set("trust proxy", 1);

  app.use(helmet({ crossOriginResourcePolicy: { policy: "same-site" } }));
  app.use(
    cors({
      origin: (origin, callback) => callback(null, !origin || config.corsOrigins.includes(origin)),
      credentials: true,
    })
  );
  // Raw body is kept for webhook signature verification.
  app.use(
    express.json({
      limit: "2mb",
      verify: (req, res, buf) => {
        if (req.originalUrl.includes("/webhooks/")) req.rawBody = buf;
      },
    })
  );
  app.use(cookieParser());

  app.get(`${config.apiPrefix}/health`, (req, res) => res.json({ status: true, message: "OK", data: { env: config.appEnv } }));

  // Webhooks authenticate by signature, not cookies, so they are exempt from CSRF.
  app.use(config.apiPrefix, (req, res, next) => (req.path.startsWith("/webhooks/") ? next() : csrfProtection(req, res, next)));
  app.use(config.apiPrefix, routes);

  app.use(notFound);
  app.use(errorHandler);
  return app;
}

module.exports = { createApp };
