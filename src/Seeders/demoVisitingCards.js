// DEMONSTRATION visiting card designs and orders, created through the real services so the
// admin module shows an order at each stage. Runs after demoOrders.js; everything belongs to
// demo users, so `npm run seed:demo:remove` deletes it.
const { User, Address, VcOrder, VcTemplate } = require("../Models");
const accessService = require("../Services/accessService");
const designs = require("../Services/vcDesignService");
const orders = require("../Services/vcOrderService");
const payments = require("../Services/vcPaymentService");

async function ctx(email) {
  const user = await User.findOne({ where: { email } });
  return accessService.loadContext(user.id);
}

async function addressFor(owner) {
  return (await Address.findOne({ where: { user_id: owner.user.id } })) || Address.findOne({ where: { company_id: owner.companyId } });
}

async function cardOrder(owner, admin, { template, customerType, quantity, options = [], employees, fields, pay = true, steps = [] }) {
  const t = await VcTemplate.findOne({ where: { code: template } });
  const draft = await designs.create(owner, { templateId: t.id, customerType });
  await designs.save(owner, draft.id, {
    name: draft.name,
    orientation: draft.orientation,
    design: draft.design,
    fields: { ...draft.fields, ...(fields || {}) },
    employees: employees || draft.employees,
  });
  const address = await addressFor(owner);
  const { order } = await orders.place(owner, { designId: draft.id, quantity, options, addressId: address.id, idempotencyKey: `demo-vc-${Date.now()}-${Math.floor(Math.random() * 1e6)}` });
  await VcOrder.update({ is_demo: true }, { where: { id: order.id } });
  if (pay) await payments.recordOffline(admin, order.id, { reference: `DEMO-${order.orderNumber}`, note: "Demo bank transfer" });
  for (const step of steps) {
    if (step === "approve") await orders.artworkDecision(admin, order.id, { decision: "approve", reason: "Looks good to print" });
    else if (step === "reject") await orders.artworkDecision(admin, order.id, { decision: "reject", reason: "The logo is low resolution. Please upload a sharper PNG or an SVG." });
    else if (step === "dispatched") await orders.setStatus(admin, order.id, { status: "dispatched", courier: "BlueDart", trackingNumber: `BD${order.orderNumber.replace(/\D/g, "")}IN` });
    else await orders.setStatus(admin, order.id, { status: step });
  }
  return order;
}

async function seedDemoVisitingCards() {
  if (process.env.APP_ENV === "production") return;
  if (await VcOrder.count({ where: { is_demo: true } })) {
    console.log("Demo visiting card orders already present");
    return;
  }
  // Job titles so the designer can pre-fill them.
  for (const [email, designation] of [["priya@demo.test", "Interior Designer"], ["anjali@acme.test", "HR Manager"], ["vikram@globex.test", "Head of Procurement"]]) {
    await User.update({ designation }, { where: { email, designation: null } });
  }
  const admin = await ctx("admin@demo.test");
  const priya = await ctx("priya@demo.test");
  const anjali = await ctx("anjali@acme.test");
  const vikram = await ctx("vikram@globex.test");

  await cardOrder(priya, admin, { template: "matrix-minimal", customerType: "individual", quantity: 200, options: ["paper_350_premium", "finish_matte_lam"], fields: { website: "www.priyasharma.design", tagline: "Spaces with soul" } });
  await cardOrder(priya, admin, { template: "onyx-gold", customerType: "individual", quantity: 100, options: ["paper_400_textured", "finish_velvet"], fields: { website: "www.priyasharma.design" }, steps: ["approve", "in_production", "dispatched", "delivered"] });
  await cardOrder(anjali, admin, {
    template: "navy-corporate",
    customerType: "corporate",
    quantity: 100,
    options: ["finish_matte_lam", "corners_rounded"],
    fields: { tagline: "Building tomorrow's software", website: "www.acme.test" },
    employees: [
      { ref: "e1", employeeCode: "AC-001", fullName: "Anjali Mehta", designation: "HR Manager", department: "People", mobile: "9820000020", email: "anjali@acme.test" },
      { ref: "e2", employeeCode: "AC-014", fullName: "Rahul Verma", designation: "Procurement Executive", department: "Operations", mobile: "9820000021", email: "rahul@acme.test" },
      { ref: "e3", employeeCode: "AC-027", fullName: "Sneha Iyer", designation: "Senior Software Engineer", department: "Engineering", mobile: "9820000022", email: "sneha@acme.test", quantity: 200 },
    ],
    steps: ["approve", "in_production"],
  });
  await cardOrder(anjali, admin, {
    template: "duo-split",
    customerType: "corporate",
    quantity: 100,
    fields: { tagline: "Building tomorrow's software", website: "www.acme.test" },
    employees: [{ ref: "e1", fullName: "Karan Shah", designation: "Sales Lead", mobile: "9820000023", email: "karan@acme.test" }],
    steps: ["reject"],
  });
  await cardOrder(vikram, admin, {
    template: "scan-connect",
    customerType: "corporate",
    quantity: 250,
    fields: { website: "www.globex.test" },
    employees: [
      { ref: "e1", fullName: "Vikram Rao", designation: "Head of Procurement", mobile: "9820000030", email: "vikram@globex.test" },
      { ref: "e2", fullName: "Meera Nair", designation: "Plant Manager", mobile: "9820000031", email: "meera@globex.test" },
    ],
    pay: false,
  });
  console.log("Demo visiting card orders: 5");
}

module.exports = { seedDemoVisitingCards };
