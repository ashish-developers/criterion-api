const { config, assertConfig } = require("./src/Config/env");
const { sequelize } = require("./src/Config/database");
const { createApp } = require("./src/app");
const scheduler = require("./src/Services/scheduler");

const problems = assertConfig();
if (problems.length) {
  problems.forEach((p) => console.error(`Configuration error: ${p}`));
  process.exit(1);
}

async function startServer() {
  try {
    await sequelize.authenticate();
  } catch (error) {
    // Says which settings were used and the likely cause (run `npm run db:check` to retry).
    require("./src/Config/dbDiagnostics").describe(error).forEach((line) => console.error(line));
    process.exit(1);
  }

  // Refuse to start on a database that is missing tables (e.g. a fresh server where the
  // migrations were never run): every request and scheduled job would fail otherwise.
  const pending = await require("./src/Migrations/runner").pending();
  if (pending.length) {
    console.error(`Database "${config.db.name}" is not up to date: ${pending.length} migration(s) not applied (${pending.join(", ")}).`);
    console.error("Run these in the api folder, then start the API again:");
    console.error("  npm run db:migrate");
    console.error("  npm run seed:reference   (roles, permissions, settings and tax master; needed in every environment)");
    process.exit(1);
  }

  const app = createApp();
  // Express 5 passes listen errors (e.g. port already in use) to this callback instead of throwing.
  const server = app.listen(config.port, (error) => {
    if (error) {
      console.error(
        error.code === "EADDRINUSE"
          ? `Port ${config.port} is already in use. Another API server is probably still running; stop it and try again.`
          : `Server failed to start: ${error.message}`
      );
      process.exit(1);
    }
    console.log(`Server running on http://localhost:${config.port}${config.apiPrefix}`);
    if (config.otp.showDevOtp) console.log("Development OTP display is ENABLED (SHOW_DEV_OTP). Never enable this in production.");
    scheduler.start();
  });

  // Graceful shutdown (deploys, process managers, Ctrl+C): stop accepting connections, let
  // in-flight requests finish, then close the database pool. Forced exit after 10 seconds.
  let stopping = false;
  const shutdown = (signal) => {
    if (stopping) return;
    stopping = true;
    console.log(`${signal} received: shutting down`);
    setTimeout(() => process.exit(1), 10_000).unref();
    server.close(() => {
      sequelize
        .close()
        .catch(() => undefined)
        .finally(() => process.exit(0));
    });
  };
  process.on("SIGTERM", () => shutdown("SIGTERM"));
  process.on("SIGINT", () => shutdown("SIGINT"));
}

startServer();
