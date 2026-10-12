// npm run admin:create -- --email admin@example.com [--name "Site Admin"] [--phone 9876543210]
// Creates a real (non-demo) platform admin. The password comes from ADMIN_PASSWORD, or a
// strong one is generated and printed once. Sign-in still requires the email OTP.
const { sequelize, User, Role, UserRole } = require("../Models");
const { hashPassword, randomToken } = require("../Utils/crypto");

function arg(name) {
  const i = process.argv.indexOf(`--${name}`);
  return i > -1 ? process.argv[i + 1] : undefined;
}

async function main() {
  const email = (arg("email") || "").trim().toLowerCase();
  if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) throw new Error("Pass a valid --email");
  const name = arg("name") || "Platform Admin";
  const phone = arg("phone") || null;
  const generated = !process.env.ADMIN_PASSWORD;
  const password = process.env.ADMIN_PASSWORD || `${randomToken(9)}#9a`;
  if (password.length < 8) throw new Error("ADMIN_PASSWORD must be at least 8 characters");

  await sequelize.transaction(async (transaction) => {
    const exists = await User.findOne({ where: sequelize.where(sequelize.fn("lower", sequelize.col("email")), email), paranoid: false, transaction });
    if (exists) throw new Error(`An account with ${email} already exists`);
    const role = await Role.findOne({ where: { code: "platform_admin", scope_type: "platform" }, transaction });
    if (!role) throw new Error("Role platform_admin is missing. Run npm run seed:reference first.");
    const user = await User.create(
      { name, email, phone, password_hash: await hashPassword(password), account_type: "staff", status: "active", email_verified_at: new Date(), is_demo: false },
      { transaction }
    );
    await UserRole.create({ user_id: user.id, role_id: role.id, scope_type: "platform", scope_id: null }, { transaction });
  });

  console.log(`Platform admin created: ${email}`);
  if (generated) console.log(`Password (shown once, change it after signing in): ${password}`);
}

main()
  .then(() => sequelize.close())
  .catch(async (error) => {
    console.error(error.message);
    await sequelize.close();
    process.exit(1);
  });
