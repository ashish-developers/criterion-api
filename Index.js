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
    console.error(`Database connection failed: ${error.message}`);
    process.exit(1);
  }

  const app = createApp();
  // Express 5 passes listen errors (e.g. port already in use) to this callback instead of throwing.
  app.listen(config.port, (error) => {
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
}

startServer();
