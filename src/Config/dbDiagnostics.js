// Explains a failed database connection: the settings actually used (never the password itself)
// and the likely cause for the common PostgreSQL / network errors. Used by Index.js at startup
// and by `npm run db:check`.
const { config } = require("./env");

function settingsSummary() {
  const db = config.db;
  return [
    `  .env file : ${config.envFile.found ? config.envFile.path : `NOT FOUND (looked for ${config.envFile.path}); using environment variables and defaults`}`,
    `  host:port : ${db.host}:${db.port}`,
    `  database  : ${db.name}`,
    `  user      : ${db.user}`,
    `  password  : ${db.password ? `set (${db.password.length} characters)` : "NOT SET"}`,
    `  ssl       : ${db.ssl ? "on (DB_SSL=true)" : "off"}`,
  ];
}

function hintFor(error) {
  const code = error?.original?.code || error?.parent?.code || error?.code;
  const message = String(error?.original?.message || error?.message || "");
  const db = config.db;
  if (!config.envFile.found && !process.env.DB_PASSWORD)
    return `The .env file was not found, so the API is using default settings. Create ${config.envFile.path} (copy .env.example) or set ENV_FILE / the DB_* variables in your process manager.`;
  if (/client password must be a string/i.test(message) || (!db.password && /SASL|password/i.test(message)))
    return "DB_PASSWORD is empty. Set it in .env. Note that `sudo -u postgres psql` logs in without a password (peer authentication over a local socket); the API connects over TCP and needs the user's password.";
  if (code === "28P01" || /password authentication failed/i.test(message))
    return `Wrong password for user "${db.user}", or the user has no password set. On the server run: sudo -u postgres psql -c "ALTER USER ${db.user} WITH PASSWORD '...'" and put the same password in DB_PASSWORD. If the password contains # or spaces, wrap it in double quotes in .env.`;
  if (code === "28000" || /no pg_hba\.conf entry|ident authentication failed|peer authentication failed/i.test(message))
    return `PostgreSQL refused this connection type (pg_hba.conf). Add a line such as "host ${db.name} ${db.user} 127.0.0.1/32 scram-sha-256" to pg_hba.conf, then reload PostgreSQL (sudo systemctl reload postgresql). If the message mentions SSL, try DB_SSL=true.`;
  if (code === "3D000" || /database .* does not exist/i.test(message))
    return `Database "${db.name}" does not exist (check DB_NAME for typos). Create it with: npm run db:create, then npm run db:migrate && npm run seed:reference.`;
  if (code === "ECONNREFUSED")
    return `Nothing is accepting connections on ${db.host}:${db.port}. Check PostgreSQL is running (sudo systemctl status postgresql), that DB_PORT is right, and that it listens on TCP (listen_addresses in postgresql.conf).${db.host === "localhost" ? ' Also try DB_HOST=127.0.0.1: "localhost" can resolve to IPv6 (::1) while PostgreSQL only listens on IPv4.' : ""}`;
  if (code === "ENOTFOUND" || code === "EAI_AGAIN") return `The host name "${db.host}" could not be resolved. Check DB_HOST.`;
  if (code === "ETIMEDOUT" || /timeout/i.test(message))
    return `Connection to ${db.host}:${db.port} timed out. A firewall or cloud security group is probably blocking the port, or the database only allows connections from certain IP addresses.`;
  if (/SSL|certificate|TLS/i.test(message)) return db.ssl ? "SSL handshake failed. Check the provider's SSL requirements." : "The server requires SSL. Set DB_SSL=true in .env.";
  if (code === "53300" || /too many connections/i.test(message)) return "PostgreSQL has reached max_connections. Close idle connections or lower the pool size.";
  return null;
}

/** Lines to print for a failed connection. */
function describe(error) {
  const code = error?.original?.code || error?.parent?.code || error?.code;
  const lines = [`Database connection failed: ${error?.original?.message || error?.message || error}${code ? ` [${code}]` : ""}`, "Settings used:", ...settingsSummary()];
  const hint = hintFor(error);
  if (hint) lines.push("Likely cause:", `  ${hint}`);
  return lines;
}

module.exports = { describe, settingsSummary, hintFor };

// `npm run db:check`: try the connection and explain the result, without starting the API.
if (require.main === module) {
  const { sequelize } = require("./database");
  sequelize
    .authenticate()
    .then(async () => {
      const [[row]] = await sequelize.query("SELECT current_user AS usr, current_database() AS db, version() AS version");
      console.log("Database connection OK");
      settingsSummary().forEach((l) => console.log(l));
      console.log(`  connected as ${row.usr} to ${row.db}\n  ${row.version.split(",")[0]}`);
      await sequelize.close();
    })
    .catch(async (error) => {
      describe(error).forEach((l) => console.error(l));
      await sequelize.close().catch(() => undefined);
      process.exit(1);
    });
}
