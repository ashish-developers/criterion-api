// Minimal forward-only SQL migration runner.
//   node src/Migrations/runner.js create   -> create the database if missing
//   node src/Migrations/runner.js up       -> apply pending migrations (each in a transaction)
//   node src/Migrations/runner.js status   -> list applied / pending migrations
//   node src/Migrations/runner.js reset    -> drop and recreate the public schema (refused in production)
const fs = require("fs");
const path = require("path");
const { Client } = require("pg");
const { config } = require("../Config/env");

const MIGRATIONS_DIR = __dirname;

function client(database = config.db.name) {
  return new Client({
    host: config.db.host,
    port: config.db.port,
    user: config.db.user,
    password: config.db.password,
    database,
    ssl: config.db.ssl ? { rejectUnauthorized: false } : undefined,
  });
}

function migrationFiles() {
  return fs
    .readdirSync(MIGRATIONS_DIR)
    .filter((f) => /^\d+_.+\.sql$/.test(f))
    .sort();
}

async function createDatabase() {
  const c = client("postgres");
  await c.connect();
  try {
    const { rowCount } = await c.query("SELECT 1 FROM pg_database WHERE datname = $1", [config.db.name]);
    if (rowCount) {
      console.log(`Database "${config.db.name}" already exists`);
    } else {
      // Identifiers cannot be parameterised; the name comes from trusted configuration.
      if (!/^[a-zA-Z0-9_]+$/.test(config.db.name)) throw new Error("DB_NAME contains invalid characters");
      await c.query(`CREATE DATABASE "${config.db.name}"`);
      console.log(`Database "${config.db.name}" created`);
    }
  } finally {
    await c.end();
  }
}

async function ensureTable(c) {
  await c.query(`CREATE TABLE IF NOT EXISTS schema_migrations (
    name VARCHAR(200) PRIMARY KEY,
    applied_at TIMESTAMPTZ NOT NULL DEFAULT now()
  )`);
}

async function up() {
  const c = client();
  await c.connect();
  try {
    await ensureTable(c);
    const applied = new Set((await c.query("SELECT name FROM schema_migrations")).rows.map((r) => r.name));
    const pending = migrationFiles().filter((f) => !applied.has(f));
    if (!pending.length) {
      console.log("No pending migrations");
      return;
    }
    for (const file of pending) {
      const sql = fs.readFileSync(path.join(MIGRATIONS_DIR, file), "utf8");
      process.stdout.write(`Applying ${file} ... `);
      await c.query("BEGIN");
      try {
        await c.query(sql);
        await c.query("INSERT INTO schema_migrations (name) VALUES ($1)", [file]);
        await c.query("COMMIT");
        console.log("done");
      } catch (error) {
        await c.query("ROLLBACK");
        console.log("FAILED");
        throw error;
      }
    }
  } finally {
    await c.end();
  }
}

async function status() {
  const c = client();
  await c.connect();
  try {
    await ensureTable(c);
    const applied = new Map((await c.query("SELECT name, applied_at FROM schema_migrations")).rows.map((r) => [r.name, r.applied_at]));
    for (const f of migrationFiles()) {
      console.log(`${applied.has(f) ? "applied " : "pending "} ${f}${applied.has(f) ? `  (${applied.get(f).toISOString()})` : ""}`);
    }
  } finally {
    await c.end();
  }
}

async function reset() {
  if (config.isProduction) throw new Error("Refusing to reset the database when APP_ENV=production");
  const c = client();
  await c.connect();
  try {
    await c.query("DROP SCHEMA public CASCADE; CREATE SCHEMA public;");
    console.log("Schema reset");
  } finally {
    await c.end();
  }
}

if (require.main === module) {
  const command = process.argv[2] || "up";
  const commands = { create: createDatabase, up, status, reset };
  if (!commands[command]) {
    console.error(`Unknown command "${command}". Use: create | up | status | reset`);
    process.exit(1);
  }
  commands[command]()
    .then(() => process.exit(0))
    .catch((error) => {
      console.error(error.message);
      process.exit(1);
    });
}

/** Migration files not yet applied to the configured database (all of them on an empty database). */
async function pending() {
  const c = client();
  await c.connect();
  try {
    const exists = (await c.query("SELECT to_regclass('public.schema_migrations') AS t")).rows[0].t;
    const applied = exists ? new Set((await c.query("SELECT name FROM schema_migrations")).rows.map((r) => r.name)) : new Set();
    return migrationFiles().filter((f) => !applied.has(f));
  } finally {
    await c.end();
  }
}

module.exports = { createDatabase, up, status, reset, pending };
