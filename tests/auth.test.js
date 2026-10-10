// Two-step authentication: registration and login both require a server-verified OTP.
const test = require("node:test");
const assert = require("node:assert/strict");
const { Client, shutdown, db } = require("./helpers");

test.after(shutdown);

const newUser = (overrides = {}) => ({
  name: "Test Buyer",
  email: `buyer${Date.now()}${Math.floor(Math.random() * 1000)}@example.com`,
  phone: "9876543210",
  password: "Secret123",
  confirmPassword: "Secret123",
  accountType: "individual",
  acceptTerms: true,
  ...overrides,
});

test("registration activates the account only after OTP verification", async () => {
  const c = new Client();
  await c.csrf();
  const input = newUser();
  const reg = await c.post("/auth/register", input);
  assert.equal(reg.status, 201);
  assert.match(reg.data.devOtp, /^\d{6}$/, "development OTP is the real generated code");
  assert.ok(!JSON.stringify(reg.body).includes("Secret123"), "password never echoed");

  // Not signed in yet
  assert.equal((await c.get("/auth/me")).status, 401);
  const { User } = await db();
  assert.equal((await User.findOne({ where: { email: input.email } })).status, "pending");

  const wrong = reg.data.devOtp === "000000" ? "111111" : "000000";
  const bad = await c.post("/auth/verify-otp", { challengeId: reg.data.challengeId, otp: wrong });
  assert.equal(bad.status, 400);
  assert.equal(bad.body.code, "OTP_INCORRECT");

  const ok = await c.post("/auth/verify-otp", { challengeId: reg.data.challengeId, otp: reg.data.devOtp });
  assert.equal(ok.status, 200);
  assert.equal(ok.data.homePath, "/account");
  assert.deepEqual(ok.data.roles, ["customer"]);
  assert.ok(c.cookies.access_token && c.cookies.refresh_token, "session cookies set");

  const reuse = await c.post("/auth/verify-otp", { challengeId: reg.data.challengeId, otp: reg.data.devOtp });
  assert.equal(reuse.status, 400);
  assert.equal(reuse.body.code, "OTP_USED");
  assert.equal((await c.get("/auth/me")).status, 200);
});

test("duplicate email is rejected and validation errors are field-level", async () => {
  const c = new Client();
  await c.csrf();
  const dup = await c.post("/auth/register", newUser({ email: "priya@demo.test" }));
  assert.equal(dup.status, 409);
  const invalid = await c.post("/auth/register", newUser({ email: "nope", password: "short", confirmPassword: "x" }));
  assert.equal(invalid.status, 422);
  assert.ok(invalid.body.details.email && invalid.body.details.password && invalid.body.details.confirmPassword);
});

test("login needs a valid password and then a valid OTP", async () => {
  const c = new Client();
  await c.csrf();
  assert.equal((await c.post("/auth/login", { email: "priya@demo.test", password: "wrong" })).status, 401);
  const start = await c.post("/auth/login", { email: "priya@demo.test", password: "Demo@1234" });
  assert.equal(start.status, 200);
  assert.equal(start.data.purpose, "login");
  assert.equal((await c.get("/auth/me")).status, 401, "password alone does not create a session");
  const verify = await c.post("/auth/verify-otp", { challengeId: start.data.challengeId, otp: start.data.devOtp });
  assert.equal(verify.status, 200);
  assert.equal(verify.data.user.email, "priya@demo.test");
});

test("expired OTPs are rejected", async () => {
  const c = new Client();
  await c.csrf();
  const start = await c.post("/auth/login", { email: "priya@demo.test", password: "Demo@1234" });
  const { VerificationChallenge } = await db();
  await VerificationChallenge.update({ expires_at: new Date(Date.now() - 1000) }, { where: { id: start.data.challengeId } });
  const res = await c.post("/auth/verify-otp", { challengeId: start.data.challengeId, otp: start.data.devOtp });
  assert.equal(res.status, 400);
  assert.equal(res.body.code, "OTP_EXPIRED");
});

test("too many wrong attempts invalidate the challenge, even for the right code", async () => {
  const c = new Client();
  await c.csrf();
  const start = await c.post("/auth/login", { email: "priya@demo.test", password: "Demo@1234" });
  const wrong = start.data.devOtp === "999999" ? "888888" : "999999";
  let last;
  for (let i = 0; i < 5; i++) last = await c.post("/auth/verify-otp", { challengeId: start.data.challengeId, otp: wrong });
  assert.equal(last.status, 429);
  const right = await c.post("/auth/verify-otp", { challengeId: start.data.challengeId, otp: start.data.devOtp });
  assert.equal(right.status, 400);
  assert.match(right.body.code, /OTP_INVALIDATED|OTP_USED/);
});

test("resend is rate limited by cooldown and issues a new code", async () => {
  const c = new Client();
  await c.csrf();
  const start = await c.post("/auth/login", { email: "priya@demo.test", password: "Demo@1234" });
  const early = await c.post("/auth/resend-otp", { challengeId: start.data.challengeId });
  assert.equal(early.status, 429);
  const { VerificationChallenge } = await db();
  await VerificationChallenge.update({ last_sent_at: new Date(Date.now() - 120000) }, { where: { id: start.data.challengeId } });
  const resent = await c.post("/auth/resend-otp", { challengeId: start.data.challengeId });
  assert.equal(resent.status, 200);
  const old = await c.post("/auth/verify-otp", { challengeId: start.data.challengeId, otp: start.data.devOtp === resent.data.devOtp ? "000001" : start.data.devOtp });
  assert.equal(old.status, 400, "previous code no longer works");
  const ok = await c.post("/auth/verify-otp", { challengeId: start.data.challengeId, otp: resent.data.devOtp });
  assert.equal(ok.status, 200);
});

test("logout revokes the session server-side", async () => {
  const c = new Client();
  await c.login("priya@demo.test");
  const token = c.cookies.access_token;
  await c.post("/auth/logout");
  const replay = new Client();
  replay.cookies.access_token = token;
  assert.equal((await replay.get("/auth/me")).status, 401, "old access token is dead after logout");
});

test("state-changing requests without the CSRF header are rejected", async () => {
  const c = new Client();
  await c.login("priya@demo.test");
  const csrf = c.cookies.csrf_token;
  delete c.cookies.csrf_token;
  const res = await c.request("PUT", "/account/profile", { name: "X Y", phone: "9876543210" }, { headers: {} });
  assert.equal(res.status, 403);
  c.cookies.csrf_token = csrf;
});

test("password reset uses an OTP and signs out other sessions", async () => {
  const c = new Client();
  await c.csrf();
  const input = newUser();
  const reg = await c.post("/auth/register", input);
  await c.post("/auth/verify-otp", { challengeId: reg.data.challengeId, otp: reg.data.devOtp });
  const other = new Client();
  await other.login(input.email, input.password);

  const anon = new Client();
  await anon.csrf();
  const unknown = await anon.post("/auth/forgot-password", { email: "nobody-here@example.com" });
  assert.equal(unknown.status, 200, "no account enumeration");
  const forgot = await anon.post("/auth/forgot-password", { email: input.email });
  const verified = await anon.post("/auth/forgot-password/verify", { challengeId: forgot.data.challengeId, otp: forgot.data.devOtp });
  assert.equal(verified.status, 200);
  const reset = await anon.post("/auth/reset-password", { challengeId: forgot.data.challengeId, resetToken: verified.data.resetToken, password: "NewSecret456", confirmPassword: "NewSecret456" });
  assert.equal(reset.status, 200);
  assert.equal((await other.get("/auth/me")).status, 401, "existing sessions revoked");
  const again = await anon.post("/auth/reset-password", { challengeId: forgot.data.challengeId, resetToken: verified.data.resetToken, password: "Another789", confirmPassword: "Another789" });
  assert.equal(again.status, 400, "reset token is single use");
  await new Client().login(input.email, "NewSecret456");
});

test("development OTP is never returned when disabled", async () => {
  const { config } = require("../src/Config/env");
  const previous = config.otp.showDevOtp;
  config.otp.showDevOtp = false;
  try {
    const c = new Client();
    await c.csrf();
    const start = await c.post("/auth/login", { email: "priya@demo.test", password: "Demo@1234" });
    assert.equal(start.status, 200);
    assert.equal(start.data.devOtp, undefined);
  } finally {
    config.otp.showDevOtp = previous;
  }
});
