// Organisation user management: bulk creation with row-level validation, idempotent retries,
// queued invitation email, set-password links, the development default password with a forced
// change on first login, deactivation, and isolation between companies, vendors and roles.
const test = require("node:test");
const assert = require("node:assert/strict");
const { Client, shutdown } = require("./helpers");

test.after(shutdown);

// Capture outgoing email instead of using the log driver, so links can be followed.
const sent = [];
let failNext = 0;
function captureMail() {
  const mailService = require("../src/Services/mailService");
  mailService.send = async (message) => {
    if (failNext > 0) {
      failNext -= 1;
      return { delivered: false, error: "SMTP timeout" };
    }
    sent.push(message);
    return { delivered: true, driver: "test" };
  };
}
const outbox = () => require("../src/Services/emailOutboxService");
const config = () => require("../src/Config/env").config;
const key = () => `k${Date.now()}${Math.floor(Math.random() * 1e6)}`;
const state = {};

test("a Business Admin validates rows: each invalid row gets its own errors and nothing is saved", async () => {
  captureMail();
  const anjali = new Client();
  await anjali.login("anjali@acme.test");
  state.anjali = anjali;
  const rows = [
    { name: "Asha Approver", email: "asha.approver@acme.test", phone: "9876500001", role: "Business Approver" },
    { name: "Bala Buyer", email: "bala.buyer@acme.test", role: "buyer", sendInvite: "yes" },
    { name: "Dup", email: "ASHA.approver@acme.test", role: "buyer" },
    { name: "Bad Email", email: "not-an-email", role: "buyer" },
    { name: "Wrong Role", email: "wrong.role@acme.test", role: "Vendor Staff" },
    { name: "Other Org", email: "other.org@acme.test", role: "buyer", organization: "Globex Industries Ltd" },
    { name: "Existing", email: "rahul@acme.test", role: "buyer" },
    { name: "A", email: "short.name@acme.test", role: "buyer", phone: "12345" },
  ];
  const res = await anjali.post("/business/users/validate", { rows });
  assert.equal(res.status, 200, JSON.stringify(res.body));
  assert.deepEqual(res.data.summary, { total: 8, valid: 2, invalid: 6 });
  const errs = res.data.rows.map((r) => r.errors);
  assert.match(errs[2].email, /Duplicate of row 1/);
  assert.match(errs[3].email, /valid email/);
  assert.match(errs[4].role, /Business Approver, Business Buyer/);
  assert.match(errs[5].organization, /your own company \(Acme Technologies Pvt Ltd\)/);
  assert.match(errs[6].email, /already exists/);
  assert.ok(errs[7].name && errs[7].phone);
  assert.equal(res.data.rows[0].data.role, "business_approver");
  const list = await anjali.get("/business/users?q=asha");
  assert.equal(list.data.length, 0, "validation saves nothing");
  state.rows = rows;
});

test("bulk creation creates the valid rows, reports the rest, and a retry with the same key creates nothing new", async () => {
  const k = key();
  const res = await state.anjali.post("/business/users/bulk", { rows: state.rows, idempotencyKey: k, source: "csv" });
  assert.equal(res.status, 201, JSON.stringify(res.body));
  assert.equal(res.data.total, 8);
  assert.equal(res.data.created, 2);
  assert.equal(res.data.failed, 6);
  assert.deepEqual(res.data.emails, { queued: 2 });
  const failed = res.data.results.filter((r) => r.status === "failed");
  assert.ok(failed.every((r) => r.errors && Object.keys(r.errors).length), "failed rows carry their errors");
  state.batchId = res.data.batchId;
  state.asha = res.data.results[0].userId;
  state.bala = res.data.results[1].userId;

  const again = await state.anjali.post("/business/users/bulk", { rows: state.rows, idempotencyKey: k, source: "csv" });
  assert.equal(again.status, 200);
  assert.equal(again.data.replayed, true);
  assert.equal(again.data.batchId, state.batchId);
  const { EmailOutbox } = require("../src/Models");
  assert.equal(await EmailOutbox.count({ where: { user_id: [state.asha, state.bala] } }), 2, "no duplicate emails on retry");
});

test("created users belong to the admin's company, are invited (no dev password) and can be searched and filtered", async () => {
  const approvers = await state.anjali.get("/business/users?role=business_approver&status=invited");
  assert.equal(approvers.status, 200);
  const asha = approvers.data.find((u) => u.email === "asha.approver@acme.test");
  assert.ok(asha, "approver listed with the invited status");
  assert.deepEqual(asha.roleLabels, ["Business Approver"]);
  assert.equal(asha.manageable, true);
  const admins = await state.anjali.get("/business/users?q=anjali");
  assert.equal(admins.data[0].manageable, false, "the admin's own account is view-only");
  const { CompanyMember, Company } = require("../src/Models");
  const acme = await Company.findOne({ where: { name: "Acme Technologies Pvt Ltd" } });
  const member = await CompanyMember.findOne({ where: { user_id: state.asha } });
  assert.equal(member.company_id, acme.id, "company assigned by the server");
  assert.equal(member.member_role, "approver");
});

test("queued emails are delivered by the worker with role, organisation, username and a set-password link", async () => {
  await outbox().processDue();
  const batch = await state.anjali.get(`/business/users/batches/${state.batchId}`);
  assert.deepEqual(batch.data.emails, { sent: 2 });
  const mail = sent.find((m) => m.to === "asha.approver@acme.test");
  assert.ok(mail, "invitation emailed");
  assert.match(mail.text, /Organisation: Acme Technologies Pvt Ltd/);
  assert.match(mail.text, /Role: Business Approver/);
  assert.match(mail.text, /Username: asha\.approver@acme\.test/);
  assert.match(mail.text, /\/login/);
  assert.doesNotMatch(mail.text, /Auth@1234/, "no shared password without the dev setting");
  state.ashaToken = decodeURIComponent(mail.text.match(/accept-invite\?token=([^\s]+)/)[1]);
});

test("the set-password link is single-use and activates the account with its role", async () => {
  const guest = new Client();
  await guest.csrf();
  const preview = await guest.post("/auth/invitations/preview", { token: state.ashaToken });
  assert.equal(preview.status, 200, JSON.stringify(preview.body));
  assert.deepEqual([preview.data.organisation, preview.data.role, preview.data.email], ["Acme Technologies Pvt Ltd", "Business Approver", "asha.approver@acme.test"]);
  const accept = await guest.post("/auth/invitations/accept", { token: state.ashaToken, password: "Asha2026x", confirmPassword: "Asha2026x" });
  assert.equal(accept.status, 200, JSON.stringify(accept.body));
  const reuse = await guest.post("/auth/invitations/accept", { token: state.ashaToken, password: "Other2026x", confirmPassword: "Other2026x" });
  assert.equal(reuse.status, 400, "link cannot be used twice");

  const asha = new Client();
  const ctx = await asha.login("asha.approver@acme.test", "Asha2026x");
  assert.equal(ctx.homePath, "/business/dashboard");
  assert.ok(ctx.permissions.includes("company.orders.approve"), "approver can approve");
  assert.ok(!ctx.permissions.includes("company.team.manage"), "approver cannot manage users");
  assert.equal((await asha.get("/business/users")).status, 403, "approvers cannot open user management");
  assert.equal((await asha.get("/business/approvals")).status, 200);
  state.ashaClient = asha;
});

test("buyers and admins of other companies cannot see or manage this company's users", async () => {
  const rahul = new Client();
  await rahul.login("rahul@acme.test");
  assert.equal((await rahul.get("/business/users")).status, 403, "buyers cannot manage users");
  assert.equal((await rahul.get("/business/approvals")).status, 403, "buyers cannot approve");

  const vikram = new Client();
  await vikram.login("vikram@globex.test");
  const theirs = await vikram.get("/business/users");
  assert.ok(!theirs.data.some((u) => u.email.endsWith("@acme.test")), "other company's users are not listed");
  assert.equal((await vikram.patch(`/business/users/${state.bala}`, { name: "Hijack" })).status, 404);
  assert.equal((await vikram.post(`/business/users/${state.bala}/status`, { active: false })).status, 404);
  assert.equal((await vikram.post(`/business/users/${state.bala}/resend-invite`)).status, 404);
  // Entity references from the client are never trusted.
  const sneaky = await vikram.post("/business/users/validate", { rows: [{ name: "Sneaky", email: "sneaky@acme.test", role: "buyer", organization: "Acme Technologies Pvt Ltd" }] });
  assert.ok(sneaky.data.rows[0].errors.organization, "cannot add users to another company");
});

test("the admin can edit a role, resend an invitation (rate-limited) and deactivate/reactivate a user", async () => {
  const edit = await state.anjali.patch(`/business/users/${state.bala}`, { name: "Bala B.", role: "business_approver" });
  assert.equal(edit.status, 200, JSON.stringify(edit.body));
  const bala = (await state.anjali.get("/business/users?q=bala")).data[0];
  assert.equal(bala.name, "Bala B.");
  assert.deepEqual(bala.roles, ["business_approver"]);
  assert.equal((await state.anjali.patch(`/business/users/${state.bala}`, { role: "business_admin" })).status, 422, "admin role not assignable here");

  // The original invitation went out moments ago; resending only waits out a short cooldown.
  assert.equal((await state.anjali.post(`/business/users/${state.bala}/resend-invite`)).status, 429, "no resend right after delivery");
  const { EmailOutbox } = require("../src/Models");
  await EmailOutbox.update({ created_at: new Date(Date.now() - 5 * 60 * 1000) }, { where: { user_id: state.bala } });
  const resend = await state.anjali.post(`/business/users/${state.bala}/resend-invite`);
  assert.equal(resend.status, 200);
  assert.equal((await state.anjali.post(`/business/users/${state.bala}/resend-invite`)).status, 429, "resend is rate-limited");

  const off = await state.anjali.post(`/business/users/${state.asha}/status`, { active: false });
  assert.equal(off.status, 200);
  assert.equal((await state.ashaClient.get("/auth/me")).status, 401, "sessions are revoked on deactivation");
  const blocked = new Client();
  await blocked.csrf();
  const login = await blocked.post("/auth/login", { email: "asha.approver@acme.test", password: "Asha2026x" });
  assert.equal(login.status, 403, "inactive users cannot sign in");
  assert.equal((await state.anjali.get("/business/users?status=inactive")).data.length, 1);
  assert.equal((await state.anjali.post(`/business/users/${state.asha}/status`, { active: true })).status, 200);
  await blocked.login("asha.approver@acme.test", "Asha2026x");

  const self = (await state.anjali.get("/business/users?q=anjali")).data[0];
  assert.equal((await state.anjali.post(`/business/users/${self.id}/status`, { active: false })).status, 403, "admins cannot deactivate themselves");
});

test("a failed email is retried with backoff and the result shows the failure separately from creation", async () => {
  await outbox().processDue(); // flush earlier emails so only this one meets the failure
  failNext = 1;
  const res = await state.anjali.post("/business/users/bulk", { rows: [{ name: "Retry Me", email: "retry.me@acme.test", role: "buyer" }], idempotencyKey: key() });
  assert.equal(res.data.created, 1);
  await outbox().processDue();
  const after = await state.anjali.get(`/business/users/batches/${res.data.batchId}`);
  assert.equal(after.data.results[0].status, "created", "the account exists");
  assert.equal(after.data.results[0].email_delivery.status, "failed", "but its email failed");
  assert.match(after.data.results[0].email_delivery.error, /SMTP timeout/);
  const { EmailOutbox } = require("../src/Models");
  const row = await EmailOutbox.findOne({ where: { to_email: "retry.me@acme.test" } });
  assert.ok(row.next_attempt_at > new Date(), "scheduled for a retry");
  await row.update({ next_attempt_at: new Date(Date.now() - 1000) });
  await outbox().processDue();
  await row.reload();
  assert.equal(row.status, "sent", "retry succeeded");
  assert.equal(row.attempts, 2);
});

test("with DEV_DEFAULT_PASSWORD, accounts start with Auth@1234, must change it on first login, and the API enforces it", async () => {
  const cfg = config();
  cfg.users.devDefaultPassword = "Auth@1234";
  cfg.users.devEmailIncludesPassword = true;
  try {
    const res = await state.anjali.post("/business/users/bulk", { rows: [{ name: "Dev Buyer", email: "dev.buyer@acme.test", role: "buyer" }], idempotencyKey: key() });
    assert.equal(res.data.created, 1);
    const { EmailOutbox, User } = require("../src/Models");
    const queued = await EmailOutbox.findOne({ where: { to_email: "dev.buyer@acme.test" } });
    assert.doesNotMatch(JSON.stringify(queued.payload), /Auth@1234/, "the password is never stored in the outbox");
    const user = await User.scope("withPassword").findOne({ where: { email: "dev.buyer@acme.test" } });
    assert.notEqual(user.password_hash, "Auth@1234");
    assert.doesNotMatch(user.password_hash, /Auth@1234/, "stored hashed");
    assert.doesNotMatch(JSON.stringify(res.body), /Auth@1234/, "never returned by the API");
    await outbox().processDue();
    const mail = sent.find((m) => m.to === "dev.buyer@acme.test");
    assert.match(mail.text, /temporary development password: Auth@1234/);

    const dev = new Client();
    const ctx = await dev.login("dev.buyer@acme.test", "Auth@1234");
    assert.equal(ctx.mustChangePassword, true);
    assert.equal(ctx.homePath, "/change-password");
    const blocked = await dev.get("/orders");
    assert.equal(blocked.status, 403);
    assert.equal(blocked.body.code, "PASSWORD_CHANGE_REQUIRED");
    assert.equal((await dev.get("/auth/me")).status, 200);
    const same = await dev.post("/auth/change-password", { currentPassword: "Auth@1234", newPassword: "Auth@1234", confirmPassword: "Auth@1234" });
    assert.equal(same.status, 400, "must choose a new password");
    const changed = await dev.post("/auth/change-password", { currentPassword: "Auth@1234", newPassword: "MyOwn2026x", confirmPassword: "MyOwn2026x" });
    assert.equal(changed.status, 200, JSON.stringify(changed.body));
    assert.equal((await dev.get("/orders")).status, 200, "full access after changing the password");
  } finally {
    cfg.users.devDefaultPassword = "";
    cfg.users.devEmailIncludesPassword = false;
  }
});

test("a platform suspension cannot be lifted by the company admin", async () => {
  const admin = new Client();
  await admin.login("admin@demo.test");
  assert.equal((await admin.post(`/admin/users/${state.bala}/status`, { status: "suspended" })).status, 200);
  const row = (await state.anjali.get("/business/users?q=bala")).data[0];
  assert.equal(row.status, "inactive");
  assert.equal(row.deactivatedElsewhere, true);
  const lift = await state.anjali.post(`/business/users/${state.bala}/status`, { active: true });
  assert.equal(lift.status, 403);
  assert.equal(lift.body.code, "SUSPENDED_BY_PLATFORM");
  assert.equal((await admin.post(`/admin/users/${state.bala}/status`, { status: "active" })).status, 200, "the platform can lift it");
});

test("a Vendor Admin adds several staff at once; staff and other vendors cannot manage them", async () => {
  const ravi = new Client();
  await ravi.login("ravi@stitchline.test");
  const res = await ravi.post("/vendor/users/bulk", {
    rows: [
      { name: "Stitch One", email: "stitch.one@stitchline.test", role: "Vendor Staff" },
      { name: "Stitch Two", email: "stitch.two@stitchline.test", role: "staff", sendInvite: false },
      { name: "Not Allowed", email: "nope@stitchline.test", role: "Vendor Admin" },
    ],
    idempotencyKey: key(),
  });
  assert.equal(res.status, 201, JSON.stringify(res.body));
  assert.equal(res.data.created, 2);
  assert.equal(res.data.failed, 1, "vendor admin role cannot be created here");
  assert.deepEqual(res.data.emails, { queued: 1, not_requested: 1 });
  const staffList = await ravi.get("/vendor/users?role=vendor_staff");
  assert.ok(staffList.data.some((u) => u.email === "stitch.one@stitchline.test"));
  const stitchOne = res.data.results[0].userId;

  const staff = new Client();
  await staff.login("staff@stitchline.test");
  assert.equal((await staff.get("/vendor/users")).status, 403, "vendor staff cannot manage users");
  const meena = new Client();
  await meena.login("meena@bagcraft.test");
  assert.equal((await meena.patch(`/vendor/users/${stitchOne}`, { name: "Hijack" })).status, 404, "other vendors cannot reach them");
  assert.ok(!(await meena.get("/vendor/users")).data.some((u) => u.email.endsWith("@stitchline.test")));
});

test("a Platform Admin creates Support Agents and Production Staff; other platform roles cannot", async () => {
  const admin = new Client();
  await admin.login("admin@demo.test");
  const res = await admin.post("/admin/platform-users/bulk", {
    rows: [
      { name: "Support Sam", email: "sam.support@demo.test", role: "Support Agent" },
      { name: "Prod Pia", email: "pia.production@demo.test", role: "production_staff" },
      { name: "Escalation", email: "escalate@demo.test", role: "Platform Admin" },
    ],
    idempotencyKey: key(),
  });
  assert.equal(res.status, 201, JSON.stringify(res.body));
  assert.equal(res.data.created, 2);
  assert.match(res.data.results[2].errors.role, /Support Agent, Production Staff/);
  const list = await admin.get("/admin/platform-users?role=support_agent");
  assert.ok(list.data.some((u) => u.email === "sam.support@demo.test"));
  const csv = await admin.get("/admin/platform-users/export", { raw: true });
  assert.match(csv.headers.get("content-type"), /text\/csv/);
  assert.match(await csv.text(), /sam\.support@demo\.test/);

  for (const email of ["support@demo.test", "production@demo.test"]) {
    const staff = new Client();
    await staff.login(email);
    assert.equal((await staff.get("/admin/platform-users")).status, 403, `${email} cannot manage platform users`);
    assert.equal((await staff.post("/admin/platform-users/bulk", { rows: [{ name: "X", email: "x@demo.test", role: "Support Agent" }], idempotencyKey: key() })).status, 403);
  }
  const customer = new Client();
  await customer.login("priya@demo.test");
  assert.equal((await customer.get("/admin/platform-users")).status, 403);
});

test("the development default password is refused in production", () => {
  const { assertConfig, config: cfg } = require("../src/Config/env");
  const before = { env: process.env.DEV_DEFAULT_PASSWORD, prod: cfg.isProduction };
  process.env.DEV_DEFAULT_PASSWORD = "Auth@1234";
  cfg.isProduction = true;
  try {
    assert.ok(assertConfig().some((p) => /DEV_DEFAULT_PASSWORD/.test(p)));
  } finally {
    cfg.isProduction = before.prod;
    if (before.env === undefined) delete process.env.DEV_DEFAULT_PASSWORD;
    else process.env.DEV_DEFAULT_PASSWORD = before.env;
  }
});
