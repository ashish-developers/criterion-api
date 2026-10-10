const { Sequelize } = require("sequelize");
const { config } = require("./env");

const sequelize = new Sequelize(config.db.name, config.db.user, config.db.password, {
  host: config.db.host,
  port: config.db.port,
  dialect: "postgres",
  logging: config.db.logging ? console.log : false,
  dialectOptions: config.db.ssl ? { ssl: { require: true, rejectUnauthorized: false } } : {},
  pool: { max: 10, min: 0, idle: 10000 },
  define: { underscored: true, timestamps: true },
});

module.exports = { sequelize, Sequelize };
