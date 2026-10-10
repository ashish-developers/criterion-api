// npm run seed            -> reference data + demo data
// npm run seed:reference  -> reference data only (safe for production)
// npm run seed:demo:remove -> delete all demonstration rows
const { config } = require("../Config/env");
const { sequelize } = require("../Models");
const { seedReference } = require("./referenceData");
const { seedDemo, removeDemo, DEMO_PASSWORD } = require("./demoData");

async function main() {
  const args = new Set(process.argv.slice(2));
  if (args.has("--remove-demo")) {
    await removeDemo();
    return;
  }
  await seedReference();
  if (args.has("--reference-only")) return;
  if (config.isProduction && !args.has("--force-demo")) {
    console.log("APP_ENV=production: demo data skipped (reference data only).");
    return;
  }
  await seedDemo();
  console.log(`Demo accounts use the password ${DEMO_PASSWORD} (see README for the account list).`);
  if (!args.has("--no-orders")) {
    const { seedDemoOrders } = require("./demoOrders");
    await seedDemoOrders();
  }
}

main()
  .then(() => sequelize.close())
  .catch(async (error) => {
    console.error(error);
    await sequelize.close();
    process.exit(1);
  });
