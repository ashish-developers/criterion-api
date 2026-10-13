const { sequelize } = require("../Config/database");
const identity = require("./identity");
const catalogue = require("./catalogue");
const commerce = require("./commerce");
const operations = require("./operations");
const blog = require("./blog");

const m = { ...identity, ...catalogue, ...commerce, ...operations, ...blog };

// ---- Identity
m.User.hasMany(m.UserRole, { foreignKey: "user_id", as: "userRoles" });
m.UserRole.belongsTo(m.User, { foreignKey: "user_id" });
m.UserRole.belongsTo(m.Role, { foreignKey: "role_id", as: "role" });
m.Role.belongsToMany(m.Permission, { through: m.RolePermission, foreignKey: "role_id", otherKey: "permission_id", as: "permissions" });
m.Permission.belongsToMany(m.Role, { through: m.RolePermission, foreignKey: "permission_id", otherKey: "role_id" });
m.Session.belongsTo(m.User, { foreignKey: "user_id" });
m.VerificationChallenge.belongsTo(m.User, { foreignKey: "user_id" });

// ---- Organisations
m.Company.hasMany(m.CompanyMember, { foreignKey: "company_id", as: "members" });
m.CompanyMember.belongsTo(m.Company, { foreignKey: "company_id", as: "company" });
m.CompanyMember.belongsTo(m.User, { foreignKey: "user_id", as: "user" });
m.User.hasMany(m.CompanyMember, { foreignKey: "user_id", as: "companyMemberships" });
m.Company.hasMany(m.Address, { foreignKey: "company_id", as: "addresses" });
m.User.hasMany(m.Address, { foreignKey: "user_id", as: "addresses" });
m.Company.hasMany(m.BrandKit, { foreignKey: "company_id", as: "brandKits" });

// ---- Tax master
m.HsnCode.belongsTo(m.TaxRate, { foreignKey: "tax_rate_id", as: "taxRate" });
m.Product.belongsTo(m.TaxRate, { foreignKey: "tax_rate_id", as: "taxRate" });
m.Category.belongsTo(m.TaxRate, { foreignKey: "default_tax_rate_id", as: "defaultTaxRate" });

// ---- Vendors
m.Vendor.belongsTo(m.User, { foreignKey: "owner_user_id", as: "owner" });
m.Vendor.hasMany(m.VendorUser, { foreignKey: "vendor_id", as: "members" });
m.VendorUser.belongsTo(m.Vendor, { foreignKey: "vendor_id", as: "vendor" });
m.VendorUser.belongsTo(m.User, { foreignKey: "user_id", as: "user" });
m.Vendor.hasMany(m.VendorCapability, { foreignKey: "vendor_id", as: "capabilities" });
m.VendorCapability.belongsTo(m.DecorationMethod, { foreignKey: "method_id", as: "method" });
m.Vendor.hasMany(m.VendorHoliday, { foreignKey: "vendor_id", as: "holidays" });

// ---- Catalogue
m.Category.belongsTo(m.Category, { foreignKey: "parent_id", as: "parent" });
m.Category.hasMany(m.Category, { foreignKey: "parent_id", as: "children" });
m.Category.hasMany(m.Product, { foreignKey: "category_id", as: "products" });
m.Product.belongsTo(m.Category, { foreignKey: "category_id", as: "category" });
m.Product.belongsTo(m.Vendor, { foreignKey: "vendor_id", as: "vendor" });
m.Product.hasMany(m.ProductVariant, { foreignKey: "product_id", as: "variants" });
m.ProductVariant.belongsTo(m.Product, { foreignKey: "product_id", as: "product" });
m.Product.hasMany(m.PrintArea, { foreignKey: "product_id", as: "printAreas" });
m.Product.hasMany(m.ProductMethod, { foreignKey: "product_id", as: "methods" });
m.ProductMethod.belongsTo(m.DecorationMethod, { foreignKey: "method_id", as: "method" });
m.Product.hasMany(m.PriceTier, { foreignKey: "product_id", as: "priceTiers" });
m.Product.hasMany(m.BundleItem, { foreignKey: "kit_product_id", as: "bundleItems" });
m.BundleItem.belongsTo(m.Product, { foreignKey: "component_product_id", as: "component" });
m.BundleItem.belongsTo(m.ProductVariant, { foreignKey: "component_variant_id", as: "componentVariant" });
m.Product.hasMany(m.ProductSource, { foreignKey: "product_id", as: "sources" });
m.ProductSource.belongsTo(m.Vendor, { foreignKey: "vendor_id", as: "vendor" });
m.InventoryMovement.belongsTo(m.ProductVariant, { foreignKey: "variant_id", as: "variant" });
m.Wishlist.belongsTo(m.Product, { foreignKey: "product_id", as: "product" });

// ---- Design
m.Design.belongsTo(m.Product, { foreignKey: "product_id", as: "product" });
m.Design.belongsTo(m.ProductVariant, { foreignKey: "variant_id", as: "variant" });
m.Design.hasMany(m.DesignVersion, { foreignKey: "design_id", as: "versions" });
m.Design.belongsTo(m.DesignVersion, { foreignKey: "current_version_id", as: "currentVersion", constraints: false });
m.DesignVersion.belongsTo(m.Design, { foreignKey: "design_id", as: "design" });
m.DesignVersion.belongsTo(m.ArtworkAsset, { foreignKey: "preview_asset_id", as: "preview" });

// ---- Cart
m.Cart.hasMany(m.CartItem, { foreignKey: "cart_id", as: "items" });
m.CartItem.belongsTo(m.Product, { foreignKey: "product_id", as: "product" });
m.CartItem.belongsTo(m.ProductVariant, { foreignKey: "variant_id", as: "variant" });
m.CartItem.belongsTo(m.DecorationMethod, { foreignKey: "method_id", as: "method" });
m.CartItem.belongsTo(m.DesignVersion, { foreignKey: "design_version_id", as: "designVersion" });

// ---- Quotes
m.Quote.belongsTo(m.User, { foreignKey: "requester_user_id", as: "requester" });
m.Quote.belongsTo(m.Company, { foreignKey: "company_id", as: "company" });
m.Quote.hasMany(m.QuoteRequestItem, { foreignKey: "quote_id", as: "requestItems" });
m.QuoteRequestItem.belongsTo(m.Product, { foreignKey: "product_id", as: "product" });
m.QuoteRequestItem.belongsTo(m.ProductVariant, { foreignKey: "variant_id", as: "variant" });
m.QuoteRequestItem.belongsTo(m.DecorationMethod, { foreignKey: "method_id", as: "method" });
m.Quote.hasMany(m.QuoteVersion, { foreignKey: "quote_id", as: "versions" });
m.Quote.belongsTo(m.QuoteVersion, { foreignKey: "current_version_id", as: "currentVersion", constraints: false });
m.QuoteVersion.hasMany(m.QuoteItem, { foreignKey: "quote_version_id", as: "items" });
m.QuoteItem.belongsTo(m.Product, { foreignKey: "product_id", as: "product" });
m.Quote.hasMany(m.QuoteMessage, { foreignKey: "quote_id", as: "messages" });
m.QuoteMessage.belongsTo(m.User, { foreignKey: "user_id", as: "user" });

// ---- Orders
m.Order.belongsTo(m.User, { foreignKey: "user_id", as: "customer" });
m.Order.belongsTo(m.Company, { foreignKey: "company_id", as: "company" });
m.Order.belongsTo(m.Quote, { foreignKey: "quote_id", as: "quote" });
m.Order.hasMany(m.OrderItem, { foreignKey: "order_id", as: "items" });
m.Order.hasMany(m.OrderEvent, { foreignKey: "order_id", as: "events" });
m.Order.hasMany(m.Payment, { foreignKey: "order_id", as: "payments" });
m.Order.hasMany(m.Refund, { foreignKey: "order_id", as: "refunds" });
m.Order.hasMany(m.Shipment, { foreignKey: "order_id", as: "shipments" });
m.Order.hasOne(m.Invoice, { foreignKey: "order_id", as: "invoice" });
m.OrderItem.belongsTo(m.Order, { foreignKey: "order_id", as: "order" });
m.OrderItem.belongsTo(m.Product, { foreignKey: "product_id", as: "product" });
m.OrderItem.belongsTo(m.ProductVariant, { foreignKey: "variant_id", as: "variant" });
m.OrderItem.belongsTo(m.DecorationMethod, { foreignKey: "method_id", as: "method" });
m.OrderItem.belongsTo(m.DesignVersion, { foreignKey: "design_version_id", as: "designVersion" });
m.OrderItem.belongsTo(m.Vendor, { foreignKey: "vendor_id", as: "vendor" });
m.OrderItem.hasMany(m.Proof, { foreignKey: "order_item_id", as: "proofs" });
m.OrderItem.hasMany(m.ProductionJob, { foreignKey: "order_item_id", as: "jobs" });
m.OrderEvent.belongsTo(m.User, { foreignKey: "actor_user_id", as: "actor" });
m.Proof.belongsTo(m.OrderItem, { foreignKey: "order_item_id", as: "orderItem" });
m.Proof.hasMany(m.ProofApproval, { foreignKey: "proof_id", as: "approvals" });
m.Proof.belongsTo(m.ArtworkAsset, { foreignKey: "preview_asset_id", as: "preview" });
m.Proof.belongsTo(m.DesignVersion, { foreignKey: "design_version_id", as: "designVersion" });
m.ProofApproval.belongsTo(m.User, { foreignKey: "user_id", as: "user" });

// ---- Fulfilment
m.ProductionJob.belongsTo(m.OrderItem, { foreignKey: "order_item_id", as: "orderItem" });
m.ProductionJob.belongsTo(m.Vendor, { foreignKey: "vendor_id", as: "vendor" });
m.ProductionJob.belongsTo(m.Proof, { foreignKey: "proof_id", as: "proof" });
m.ProductionJob.belongsTo(m.DecorationMethod, { foreignKey: "method_id", as: "method" });
m.ProductionJob.hasMany(m.JobEvent, { foreignKey: "job_id", as: "events" });
m.ProductionJob.hasMany(m.QcCheck, { foreignKey: "job_id", as: "qcChecks" });
m.JobEvent.belongsTo(m.User, { foreignKey: "actor_user_id", as: "actor" });
m.Shipment.hasMany(m.ShipmentItem, { foreignKey: "shipment_id", as: "items" });
m.Shipment.hasMany(m.TrackingEvent, { foreignKey: "shipment_id", as: "trackingEvents" });
m.Shipment.belongsTo(m.Order, { foreignKey: "order_id", as: "order" });
m.ShipmentItem.belongsTo(m.OrderItem, { foreignKey: "order_item_id", as: "orderItem" });

// ---- Money
m.Payment.belongsTo(m.Order, { foreignKey: "order_id", as: "order" });
m.Refund.belongsTo(m.Order, { foreignKey: "order_id", as: "order" });
m.Invoice.belongsTo(m.Order, { foreignKey: "order_id", as: "order" });
m.Settlement.belongsTo(m.Vendor, { foreignKey: "vendor_id", as: "vendor" });
m.Settlement.hasMany(m.SettlementLine, { foreignKey: "settlement_id", as: "lines" });
m.Commission.belongsTo(m.OrderItem, { foreignKey: "order_item_id", as: "orderItem" });
m.Commission.belongsTo(m.Vendor, { foreignKey: "vendor_id", as: "vendor" });

// ---- Support
m.Ticket.belongsTo(m.User, { foreignKey: "user_id", as: "user" });
m.Ticket.belongsTo(m.Order, { foreignKey: "order_id", as: "order" });
m.Ticket.belongsTo(m.OrderItem, { foreignKey: "order_item_id", as: "orderItem" });
m.Ticket.belongsTo(m.User, { foreignKey: "assigned_to", as: "assignee" });
m.Ticket.hasMany(m.TicketMessage, { foreignKey: "ticket_id", as: "messages" });
m.TicketMessage.belongsTo(m.User, { foreignKey: "user_id", as: "user" });
m.Review.belongsTo(m.User, { foreignKey: "user_id", as: "user" });
m.Review.belongsTo(m.Product, { foreignKey: "product_id", as: "product" });
m.AuditLog.belongsTo(m.User, { foreignKey: "actor_user_id", as: "actor" });

// ---- Blog
m.UserPermission.belongsTo(m.Permission, { foreignKey: "permission_id", as: "permission" });
m.BlogPost.belongsTo(m.User, { foreignKey: "author_id", as: "author" });
m.BlogPost.belongsTo(m.BlogCategory, { foreignKey: "category_id", as: "category" });
m.BlogPost.belongsToMany(m.BlogTag, { through: m.BlogPostTag, foreignKey: "post_id", otherKey: "tag_id", as: "tags" });
m.BlogTag.belongsToMany(m.BlogPost, { through: m.BlogPostTag, foreignKey: "tag_id", otherKey: "post_id", as: "posts" });
m.BlogPostHistory.belongsTo(m.User, { foreignKey: "actor_user_id", as: "actor" });

module.exports = { sequelize, ...m };
