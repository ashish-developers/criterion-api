const { sequelize } = require("../Config/database");

const PREFIXES = {
  order: "ORD",
  quote: "QT",
  invoice: "INV",
  job: "JOB",
  shipment: "SHP",
  ticket: "TKT",
  settlement: "STL",
};

// Atomically increments a named counter and returns e.g. "ORD-000042".
// Runs inside the caller's transaction when one is given, so numbers roll back with it.
async function nextNumber(kind, transaction) {
  const prefix = PREFIXES[kind];
  if (!prefix) throw new Error(`Unknown sequence ${kind}`);
  const [rows] = await sequelize.query(
    `INSERT INTO number_sequences (name, value) VALUES (:name, 1)
     ON CONFLICT (name) DO UPDATE SET value = number_sequences.value + 1
     RETURNING value`,
    { replacements: { name: kind }, transaction }
  );
  return `${prefix}-${String(rows[0].value).padStart(6, "0")}`;
}

module.exports = { nextNumber };
