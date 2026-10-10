const { DataTypes } = require("sequelize");
const { sequelize } = require("../Config/database");

// pg returns BIGINT and NUMERIC as strings. Money is stored in paise (BIGINT) and
// rates as NUMERIC; both fit safely in JS numbers, so these columns are parsed on read.
const NUMERIC_MARKER = Symbol("numeric");

const T = {
  uuidPk: { type: DataTypes.UUID, primaryKey: true, defaultValue: DataTypes.UUIDV4 },
  intPk: { type: DataTypes.INTEGER, primaryKey: true, autoIncrement: true },
  bigPk: { type: DataTypes.BIGINT, primaryKey: true, autoIncrement: true },
  uuid: DataTypes.UUID,
  str: DataTypes.STRING,
  text: DataTypes.TEXT,
  int: DataTypes.INTEGER,
  money: { type: DataTypes.BIGINT, [NUMERIC_MARKER]: true },
  decimal: { type: DataTypes.DECIMAL, [NUMERIC_MARKER]: true },
  bool: DataTypes.BOOLEAN,
  date: DataTypes.DATEONLY,
  time: DataTypes.DATE,
  json: DataTypes.JSONB,
  uuids: DataTypes.ARRAY(DataTypes.UUID),
  strings: DataTypes.ARRAY(DataTypes.TEXT),
};

function normalise(attributes) {
  const out = {};
  for (const [key, value] of Object.entries(attributes)) {
    if (value && value[NUMERIC_MARKER]) {
      out[key] = {
        type: value.type,
        get() {
          const raw = this.getDataValue(key);
          return raw === null || raw === undefined ? raw : Number(raw);
        },
      };
    } else {
      out[key] = value;
    }
  }
  return out;
}

/**
 * define("User", "users", {...}, { timestamps: "both" | "created" | false, paranoid })
 * Column definitions mirror the SQL migrations, which are the source of truth for the schema.
 */
function define(name, tableName, attributes, { timestamps = "both", paranoid = false, ...rest } = {}) {
  // Timestamp attributes keep their snake_case column names (created_at, not createdAt)
  // so instances, raw queries and API responses all use the same keys.
  const options = { tableName, underscored: true, createdAt: "created_at", updatedAt: "updated_at", ...rest };
  if (timestamps === false) options.timestamps = false;
  else if (timestamps === "created") Object.assign(options, { timestamps: true, updatedAt: false });
  else options.timestamps = true;
  if (paranoid) Object.assign(options, { paranoid: true, deletedAt: "deleted_at" });
  return sequelize.define(name, normalise(attributes), options);
}

module.exports = { define, T, DataTypes, sequelize };
