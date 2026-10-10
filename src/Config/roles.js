// Role and permission catalogue (Section 4.3 of the specification).
// Seeded into roles / permissions / role_permissions; the API enforces these server-side.

const PERMISSIONS = {
  // Customer / buyer self-service
  "shop.purchase": ["shop", "Use cart and checkout"],
  "designs.manage_own": ["design", "Create and manage own designs and artwork"],
  "quotes.request": ["quotes", "Request quotations"],
  "tickets.create": ["support", "Raise support tickets on own orders"],
  "reviews.write": ["shop", "Review purchased products"],

  // Business (company scoped)
  "company.view": ["business", "View company profile, orders and quotes"],
  "company.manage": ["business", "Edit company profile, billing and addresses"],
  "company.team.manage": ["business", "Invite and manage team members"],
  "company.orders.approve": ["business", "Approve orders and proofs above the spend limit"],
  "company.brand.manage": ["business", "Manage brand kit and approved templates"],

  // Vendor (vendor scoped)
  "vendor.profile.manage": ["vendor", "Manage vendor profile, KYC and capabilities"],
  "vendor.listings.manage": ["vendor", "Manage vendor product listings and prices"],
  "vendor.jobs.view": ["vendor", "View assigned production jobs"],
  "vendor.jobs.update": ["vendor", "Accept jobs and update production milestones"],
  "vendor.settlements.view": ["vendor", "View settlements and payouts"],
  "vendor.team.manage": ["vendor", "Manage vendor staff"],

  // Platform staff
  "admin.dashboard.view": ["admin", "View the admin dashboard"],
  "catalogue.manage": ["catalogue", "Manage categories, products, variants and print areas"],
  "pricing.manage": ["catalogue", "Manage price tiers, methods and setup fees"],
  "orders.view": ["orders", "View all orders"],
  "orders.manage": ["orders", "Update orders, cancel and change state"],
  "proofs.manage": ["orders", "Create and send proofs"],
  "quotes.view": ["quotes", "View all quotations"],
  "quotes.manage": ["quotes", "Price, send and revise quotations"],
  "customers.view": ["customers", "View customers and companies"],
  "customers.manage": ["customers", "Manage customers and company accounts"],
  "vendors.view": ["vendors", "View vendors"],
  "vendors.manage": ["vendors", "Approve, suspend and configure vendors"],
  "production.view": ["production", "View production jobs and job board"],
  "production.manage": ["production", "Assign order lines and update production"],
  "qc.perform": ["production", "Record quality checks"],
  "inventory.manage": ["inventory", "Adjust stock and view inventory"],
  "shipping.manage": ["shipping", "Create shipments and update tracking"],
  "payments.view": ["finance", "View payments and invoices"],
  "refunds.request": ["finance", "Raise refund requests"],
  "refunds.approve": ["finance", "Approve and process refunds"],
  "coupons.manage": ["finance", "Manage coupons and promotions"],
  "settlements.manage": ["finance", "Generate and pay vendor settlements"],
  "reports.view": ["reports", "View reports and export CSV"],
  "settings.manage": ["settings", "Manage platform settings"],
  "roles.manage": ["settings", "Manage roles and permissions"],
  "audit.view": ["settings", "View the audit log"],
  "tickets.manage": ["support", "Manage all support tickets"],
  "cms.manage": ["settings", "Manage CMS pages, policies and FAQs"],
  "reviews.moderate": ["catalogue", "Moderate product reviews"],
};

const CUSTOMER_BASE = ["shop.purchase", "designs.manage_own", "quotes.request", "tickets.create", "reviews.write"];
const ALL = Object.keys(PERMISSIONS);
const ADMIN_PERMS = ALL.filter((p) => !/^(vendor\.|company\.)/.test(p) && !CUSTOMER_BASE.includes(p));

const ROLES = {
  customer: { name: "Customer", scope: "self", portal: "customer", permissions: CUSTOMER_BASE },
  business_buyer: {
    name: "Business buyer",
    scope: "company",
    portal: "business",
    permissions: [...CUSTOMER_BASE, "company.view"],
  },
  business_approver: {
    name: "Business approver",
    scope: "company",
    portal: "business",
    permissions: [...CUSTOMER_BASE, "company.view", "company.orders.approve"],
  },
  business_admin: {
    name: "Business admin",
    scope: "company",
    portal: "business",
    permissions: [
      ...CUSTOMER_BASE,
      "company.view",
      "company.manage",
      "company.team.manage",
      "company.orders.approve",
      "company.brand.manage",
    ],
  },
  vendor_admin: {
    name: "Vendor admin",
    scope: "vendor",
    portal: "vendor",
    permissions: [
      "vendor.profile.manage",
      "vendor.listings.manage",
      "vendor.jobs.view",
      "vendor.jobs.update",
      "vendor.settlements.view",
      "vendor.team.manage",
    ],
  },
  vendor_staff: { name: "Vendor staff", scope: "vendor", portal: "vendor", permissions: ["vendor.jobs.view", "vendor.jobs.update"] },
  production_staff: {
    name: "Production staff",
    scope: "platform",
    portal: "admin",
    // No pricing or payment data (Section 4.3).
    permissions: ["admin.dashboard.view", "production.view", "production.manage", "qc.perform", "shipping.manage", "inventory.manage", "proofs.manage"],
  },
  support_agent: {
    name: "Support agent",
    scope: "platform",
    portal: "admin",
    permissions: ["admin.dashboard.view", "orders.view", "quotes.view", "customers.view", "tickets.manage", "refunds.request", "production.view", "vendors.view"],
  },
  platform_admin: { name: "Platform admin / finance", scope: "platform", portal: "admin", permissions: ADMIN_PERMS },
};

// Refunds above this amount raised by support need finance (refunds.approve) sign-off.
const SUPPORT_REFUND_LIMIT_PAISE = 200000;

module.exports = { PERMISSIONS, ROLES, SUPPORT_REFUND_LIMIT_PAISE };
