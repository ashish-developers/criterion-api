// DEMONSTRATION data only. Every row created here is flagged is_demo (or belongs to a
// demo user/product) and can be removed with `npm run seed:demo:remove`.
// Never run this against production.
const {
  sequelize,
  User,
  Company,
  CompanyMember,
  Address,
  Vendor,
  VendorUser,
  VendorCapability,
  DecorationMethod,
  Category,
  Product,
  ProductVariant,
  PrintArea,
  ProductMethod,
  PriceTier,
  BundleItem,
  ProductSource,
  InventoryMovement,
  Coupon,
} = require("../Models");
const { hashPassword, encrypt } = require("../Utils/crypto");
const authService = require("../Services/authService");

const DEMO_PASSWORD = "Demo@1234";
const rupees = (r) => Math.round(r * 100);
const IMG = (type, color) => `/demo/products/${type}-${color}.svg`;

const COLOR_HEX = {
  white: "#ffffff", black: "#262626", navy: "#1e2a4a", red: "#c62828", grey: "#9e9e9e", royal: "#1565c0",
  maroon: "#7b1f2b", teal: "#00897b", brown: "#6d4c41", tan: "#c8a27a", silver: "#b0b7bf", gold: "#d4a017",
  natural: "#e8dcc4", walnut: "#5d4037",
};
const COLOR_NAME = { white: "White", black: "Black", navy: "Navy", red: "Red", grey: "Grey", royal: "Royal Blue", maroon: "Maroon", teal: "Teal", brown: "Brown", tan: "Tan", silver: "Silver", gold: "Gold", natural: "Natural", walnut: "Walnut" };

const CATEGORIES = [
  { slug: "apparel", name: "Apparel", description: "T-shirts, polos, hoodies and caps with your logo or design", image: "/demo/products/tshirt-navy.svg", lead: 5, sort: 1,
    children: [{ slug: "t-shirts", name: "T-shirts" }, { slug: "polos", name: "Polo shirts" }, { slug: "hoodies", name: "Hoodies & sweatshirts" }, { slug: "caps", name: "Caps" }] },
  { slug: "office-stationery", name: "Office & stationery", description: "Diaries, notebooks, planners and pens", image: "/demo/products/diary-brown.svg", lead: 6, sort: 2,
    children: [{ slug: "diaries", name: "Diaries & planners" }, { slug: "notebooks", name: "Notebooks" }, { slug: "pens", name: "Pens" }] },
  { slug: "drinkware", name: "Drinkware", description: "Mugs, tumblers and bottles", image: "/demo/products/mug-red.svg", lead: 3, sort: 3,
    children: [{ slug: "mugs", name: "Mugs" }, { slug: "bottles", name: "Bottles & tumblers" }] },
  { slug: "accessories", name: "Accessories", description: "Bags, keychains and everyday carry", image: "/demo/products/tote-natural.svg", lead: 5, sort: 4,
    children: [{ slug: "bags", name: "Bags" }, { slug: "keychains", name: "Keychains" }] },
  { slug: "awards-keepsakes", name: "Awards & keepsakes", description: "Trophies, plaques and photo frames", image: "/demo/products/trophy-gold.svg", lead: 4, sort: 5, children: [] },
  { slug: "corporate-gift-kits", name: "Corporate gift kits", description: "Welcome kits, festive hampers and client boxes", image: "/demo/products/kit-maroon.svg", lead: 10, sort: 6, children: [] },
  { slug: "event-promotional", name: "Event & promotional", description: "Event T-shirts, lanyards and giveaways", image: "/demo/products/lanyard-royal.svg", lead: 5, sort: 7, children: [] },
];

// method entries: [code, costPerUnitRupees, setupRupees, moq, isDefault]
const PRODUCTS = [
  { slug: "classic-cotton-round-neck-t-shirt", name: "Classic Cotton Round-Neck T-Shirt", category: "t-shirts", type: "tshirt",
    short: "180 GSM combed cotton tee for everyday branding and personalised gifts.", base: 180, pack: 8, hsn: "6109", gst: 5, moq: 1, lead: 4, weight: 200,
    colors: ["white", "black", "navy", "red", "grey"], sizes: ["S", "M", "L", "XL", "XXL"], material: "100% cotton, 180 GSM",
    methods: [["dtf", 60, 0, 1, true], ["screen_print", 22, 1500, 25, false], ["embroidery", 45, 800, 25, false]],
    areas: [["front", "Front", 280, 350, { x: 34, y: 25, w: 32, h: 38 }], ["back", "Back", 280, 380, { x: 32, y: 22, w: 36, h: 44 }]],
    occasions: ["Birthday", "Onboarding", "Event"], tags: ["tshirt", "tee", "cotton", "apparel"], featured: true },
  { slug: "premium-pique-polo-t-shirt", name: "Premium Pique Polo T-Shirt", category: "polos", type: "polo",
    short: "220 GSM pique polo with ribbed collar. Popular for corporate uniforms.", base: 260, pack: 10, hsn: "6105", gst: 5, moq: 10, lead: 7, weight: 260,
    colors: ["white", "navy", "black", "maroon"], sizes: ["S", "M", "L", "XL", "XXL"], material: "Cotton-poly pique, 220 GSM",
    methods: [["embroidery", 45, 800, 25, true], ["dtf", 55, 0, 10, false]],
    areas: [["left_chest", "Left chest", 90, 75, { x: 55, y: 28, w: 14, h: 12 }], ["back", "Back", 280, 300, { x: 32, y: 26, w: 36, h: 40 }]],
    occasions: ["Onboarding", "Uniform"], tags: ["polo", "collar", "uniform", "corporate"], featured: true },
  { slug: "fleece-pullover-hoodie", name: "Fleece Pullover Hoodie", category: "hoodies", type: "hoodie",
    short: "Brushed fleece hoodie with kangaroo pocket for teams and clubs.", base: 420, pack: 15, hsn: "6110", gst: 5, moq: 1, lead: 6, weight: 550,
    colors: ["black", "grey", "navy", "maroon"], sizes: ["S", "M", "L", "XL", "XXL"], material: "Cotton-rich fleece, 300 GSM",
    methods: [["dtf", 70, 0, 1, true], ["screen_print", 28, 1500, 25, false], ["embroidery", 55, 800, 25, false]],
    areas: [["front", "Front", 280, 280, { x: 35, y: 30, w: 30, h: 30 }]],
    occasions: ["Event", "Birthday"], tags: ["hoodie", "sweatshirt", "winter"] },
  { slug: "structured-cotton-cap", name: "Structured Cotton Cap", category: "caps", type: "cap",
    short: "Six-panel structured cap with adjustable strap.", base: 110, pack: 6, hsn: "6505", gst: 5, moq: 10, lead: 5, weight: 90,
    colors: ["black", "navy", "white", "red"], sizes: ["Free size"], material: "Cotton twill",
    methods: [["embroidery", 35, 800, 25, true], ["dtf", 40, 0, 10, false]],
    areas: [["front", "Front panel", 100, 55, { x: 38, y: 33, w: 24, h: 16 }]],
    occasions: ["Event"], tags: ["cap", "hat", "headwear"] },
  { slug: "executive-pu-leather-diary-a5", name: "Executive PU Leather Diary A5", category: "diaries", type: "diary",
    short: "Hard-bound A5 diary, 192 ruled pages, ribbon marker and elastic closure.", base: 240, pack: 12, hsn: "4820", gst: 18, moq: 1, lead: 6, weight: 420,
    colors: ["black", "brown", "navy", "tan"], material: "PU leather cover, 80 GSM paper",
    methods: [["uv_print", 40, 0, 1, true], ["debossing", 30, 1200, 25, false], ["laser_engraving", 35, 0, 1, false]],
    areas: [["cover", "Front cover", 100, 90, { x: 34, y: 30, w: 32, h: 30 }]],
    occasions: ["Onboarding", "Diwali", "New Year"], tags: ["diary", "planner", "notebook", "journal"], featured: true },
  { slug: "spiral-kraft-notebook-a5", name: "Spiral Kraft Notebook A5", category: "notebooks", type: "notebook",
    short: "Eco-friendly kraft cover notebook with 120 ruled pages.", base: 90, pack: 5, hsn: "4820", gst: 18, moq: 10, lead: 5, weight: 250,
    colors: ["natural", "black", "royal"], material: "Kraft board cover, recycled paper",
    methods: [["uv_print", 30, 0, 10, true], ["screen_print", 12, 1200, 50, false]],
    areas: [["cover", "Front cover", 110, 130, { x: 37, y: 25, w: 30, h: 35 }]],
    occasions: ["Onboarding", "Event"], tags: ["notebook", "spiral", "eco"] },
  { slug: "metal-ball-pen", name: "Metal Ball Pen", category: "pens", type: "pen",
    short: "Weighted metal twist pen with smooth blue refill.", base: 45, pack: 3, hsn: "9608", gst: 18, moq: 25, lead: 5, weight: 30, livePreview: false,
    colors: ["black", "royal", "red", "silver"], material: "Brass barrel",
    methods: [["laser_engraving", 12, 0, 25, true], ["pad_print", 6, 900, 100, false]],
    areas: [["barrel", "Barrel", 40, 8, { x: 32, y: 45, w: 30, h: 8 }]],
    occasions: ["Onboarding", "Event"], tags: ["pen", "writing", "giveaway"] },
  { slug: "undated-planner", name: "Undated Weekly Planner", category: "diaries", type: "diary",
    short: "Undated weekly planner with goal pages, ideal for festive gifting.", base: 260, pack: 12, hsn: "4820", gst: 18, moq: 1, lead: 6, weight: 380,
    colors: ["tan", "black"], material: "Linen-finish hard cover",
    methods: [["uv_print", 40, 0, 1, true], ["debossing", 30, 1200, 25, false]],
    areas: [["cover", "Front cover", 100, 90, { x: 34, y: 30, w: 32, h: 30 }]],
    occasions: ["New Year", "Diwali"], tags: ["planner", "diary", "organiser"] },
  { slug: "classic-ceramic-coffee-mug", name: "Classic Ceramic Coffee Mug 330 ml", category: "mugs", type: "mug",
    short: "Dishwasher-safe ceramic mug with a vivid sublimation print.", base: 85, pack: 15, hsn: "6912", gst: 12, moq: 1, lead: 2, weight: 380,
    colors: ["white", "black", "red"], material: "AAA-grade ceramic, 330 ml",
    methods: [["sublimation", 35, 0, 1, true], ["uv_print", 45, 0, 1, false]],
    areas: [["front", "Front", 90, 80, { x: 30, y: 38, w: 32, h: 32 }], ["wrap", "Wrap-around", 200, 90, { x: 23, y: 33, w: 44, h: 40 }]],
    occasions: ["Birthday", "Anniversary", "Diwali"], tags: ["mug", "coffee", "photo mug", "cup"], featured: true },
  { slug: "magic-colour-changing-mug", name: "Magic Colour-Changing Mug", category: "mugs", type: "mug",
    short: "Black mug that reveals your photo when filled with a hot drink.", base: 150, pack: 15, hsn: "6912", gst: 12, moq: 1, lead: 3, weight: 400,
    colors: ["black"], material: "Heat-sensitive coated ceramic, 330 ml",
    methods: [["sublimation", 40, 0, 1, true]],
    areas: [["wrap", "Wrap-around", 200, 90, { x: 23, y: 33, w: 44, h: 40 }]],
    occasions: ["Birthday", "Anniversary"], tags: ["magic mug", "photo mug", "gift"] },
  { slug: "stainless-steel-water-bottle", name: "Stainless Steel Water Bottle 750 ml", category: "bottles", type: "bottle",
    short: "Double-wall insulated bottle keeps drinks cold for 24 hours.", base: 260, pack: 15, hsn: "7323", gst: 12, moq: 1, lead: 4, weight: 420,
    colors: ["silver", "black", "royal", "teal"], material: "304 stainless steel",
    methods: [["laser_engraving", 40, 0, 1, true], ["uv_print", 45, 0, 1, false]],
    areas: [["body", "Body", 60, 120, { x: 37, y: 40, w: 26, h: 40 }]],
    occasions: ["Onboarding", "Event", "Diwali"], tags: ["bottle", "flask", "water bottle", "steel"], featured: true },
  { slug: "insulated-travel-tumbler", name: "Insulated Travel Tumbler 450 ml", category: "bottles", type: "tumbler",
    short: "Spill-proof tumbler with slide lid for coffee on the go.", base: 310, pack: 15, hsn: "7323", gst: 12, moq: 1, lead: 4, weight: 350,
    colors: ["black", "white", "teal"], material: "Stainless steel with powder coat",
    methods: [["laser_engraving", 40, 0, 1, true], ["uv_print", 45, 0, 1, false]],
    areas: [["body", "Body", 60, 110, { x: 38, y: 32, w: 24, h: 40 }]],
    occasions: ["Onboarding", "Diwali"], tags: ["tumbler", "travel mug", "coffee"] },
  { slug: "canvas-tote-bag", name: "Canvas Tote Bag", category: "bags", type: "tote",
    short: "Heavy 10 oz canvas tote with long handles.", base: 95, pack: 4, hsn: "6305", gst: 5, moq: 1, lead: 4, weight: 220,
    colors: ["natural", "black", "navy"], material: "10 oz cotton canvas",
    methods: [["dtf", 55, 0, 1, true], ["screen_print", 20, 1200, 25, false]],
    areas: [["front", "Front", 280, 280, { x: 30, y: 42, w: 40, h: 40 }]],
    occasions: ["Event", "Wedding"], tags: ["tote", "bag", "shopping bag", "eco"] },
  { slug: "metal-keychain", name: "Rectangular Metal Keychain", category: "keychains", type: "keychain",
    short: "Zinc-alloy keychain with split ring, engraved or printed.", base: 55, pack: 3, hsn: "7326", gst: 18, moq: 10, lead: 3, weight: 40,
    colors: ["silver", "black"], material: "Zinc alloy",
    methods: [["laser_engraving", 15, 0, 10, true], ["uv_print", 20, 0, 10, false]],
    areas: [["face", "Face", 40, 45, { x: 35, y: 47, w: 30, h: 33 }]],
    occasions: ["Event", "Diwali"], tags: ["keychain", "keyring", "giveaway"] },
  { slug: "wooden-photo-frame", name: "Wooden Photo Frame 6x8", category: "awards-keepsakes", type: "frame",
    short: "Solid wood frame with a printed photo panel.", base: 210, pack: 20, hsn: "4414", gst: 12, moq: 1, lead: 3, weight: 500,
    colors: ["walnut", "black", "white"], material: "Pine wood with MDF photo panel",
    methods: [["uv_print", 60, 0, 1, true]],
    areas: [["photo", "Photo panel", 150, 200, { x: 26, y: 23, w: 48, h: 55 }]],
    occasions: ["Birthday", "Anniversary", "Wedding"], tags: ["frame", "photo frame", "keepsake"], featured: true },
  { slug: "crystal-finish-trophy-cup", name: "Metal Trophy Cup", category: "awards-keepsakes", type: "trophy",
    short: "Classic trophy cup on a black base with engraved plate.", base: 450, pack: 25, hsn: "8306", gst: 18, moq: 1, lead: 4, weight: 900,
    colors: ["gold", "silver"], material: "Metal cup, ABS base",
    methods: [["laser_engraving", 50, 0, 1, true]],
    areas: [["cup", "Cup front", 60, 60, { x: 38, y: 22, w: 24, h: 24 }]],
    occasions: ["Award", "Event"], tags: ["trophy", "award", "cup"] },
  { slug: "printed-event-lanyard", name: "Printed Event Lanyard with ID Holder", category: "event-promotional", type: "lanyard",
    short: "20 mm polyester lanyard printed edge to edge, with badge holder.", base: 25, pack: 2, hsn: "6307", gst: 12, moq: 100, lead: 5, weight: 30, livePreview: false,
    colors: ["royal", "black", "red"], material: "Polyester",
    methods: [["sublimation", 12, 0, 100, true], ["screen_print", 6, 1200, 100, false]],
    areas: [["strap", "Strap", 900, 20, { x: 34, y: 6, w: 10, h: 48 }]],
    occasions: ["Event"], tags: ["lanyard", "id card", "conference"] },
  { slug: "event-dri-fit-t-shirt", name: "Event Dri-Fit T-Shirt", category: "event-promotional", type: "tshirt",
    short: "Lightweight polyester tee for marathons and college fests. Sublimation friendly.", base: 140, pack: 6, hsn: "6109", gst: 5, moq: 25, lead: 5, weight: 150,
    colors: ["white", "red", "navy"], sizes: ["S", "M", "L", "XL", "XXL"], material: "100% polyester dri-fit, 140 GSM",
    methods: [["sublimation", 45, 0, 25, true], ["screen_print", 18, 1500, 50, false]],
    areas: [["front", "Front", 280, 350, { x: 34, y: 25, w: 32, h: 38 }], ["back", "Back", 280, 380, { x: 32, y: 22, w: 36, h: 44 }]],
    occasions: ["Event", "Sports"], tags: ["dri-fit", "sports tee", "event tshirt", "marathon"] },
];

const KITS = [
  { slug: "new-joiner-welcome-kit", name: "New Joiner Welcome Kit", type: "kit", color: "black",
    short: "Branded welcome box with T-shirt, diary, pen and steel bottle.", pack: 120, lead: 10, moq: 25, gst: 18, hsn: "4819",
    components: [["classic-cotton-round-neck-t-shirt", 1], ["executive-pu-leather-diary-a5", 1], ["metal-ball-pen", 1], ["stainless-steel-water-bottle", 1]],
    occasions: ["Onboarding"], tags: ["welcome kit", "onboarding", "joining kit", "hamper"] },
  { slug: "diwali-festive-hamper", name: "Diwali Festive Hamper", type: "kit", color: "maroon",
    short: "Festive box with ceramic mug, planner and keychain, branded sleeve included.", pack: 150, lead: 10, moq: 25, gst: 18, hsn: "4819",
    components: [["classic-ceramic-coffee-mug", 1], ["undated-planner", 1], ["metal-keychain", 1]],
    occasions: ["Diwali"], tags: ["diwali", "hamper", "festive gift", "corporate gift"] },
];

const VENDOR_LISTINGS = [
  { vendor: "bagcraft-studio", slug: "laptop-backpack-15", name: "Laptop Backpack 15.6\"", category: "bags", type: "backpack",
    short: "Water-resistant laptop backpack with padded compartment. Sold and shipped by BagCraft Studio.", base: 990, pack: 0, hsn: "4202", gst: 18, moq: 1, lead: 6, weight: 800,
    colors: ["black", "grey", "navy"], material: "600D polyester", methods: [["embroidery", 60, 800, 10, true], ["screen_print", 30, 1500, 25, false]],
    areas: [["pocket", "Front pocket", 150, 100, { x: 35, y: 57, w: 30, h: 23 }]], tags: ["backpack", "laptop bag", "bag"], occasions: ["Onboarding"] },
  { vendor: "craftwood-gifts", slug: "engraved-walnut-keychain", name: "Engraved Walnut Keychain", category: "keychains", type: "keychain",
    short: "Hand-finished walnut wood keychain, engraved with a name or logo. Sold by Craftwood Gifts.", base: 140, pack: 0, hsn: "4420", gst: 12, moq: 1, lead: 4, weight: 30,
    colors: ["walnut"], material: "Walnut wood", methods: [["laser_engraving", 20, 0, 1, true]],
    areas: [["face", "Face", 40, 45, { x: 35, y: 47, w: 30, h: 33 }]], tags: ["keychain", "wooden", "engraved"], occasions: ["Birthday", "Wedding"] },
];

// Vendor listings are priced by the vendor; the margin column adds no platform markup (commission is deducted at settlement).
const VENDOR_TIERS = [
  { min_qty: 1, max_qty: 49, margin_pct: 0, checkout_path: "instant" },
  { min_qty: 50, max_qty: 199, margin_pct: -5, checkout_path: "instant" },
  { min_qty: 200, max_qty: null, margin_pct: -8, checkout_path: "quote_only" },
];

const USERS = [
  { key: "admin", name: "Aarav Mehta", email: "admin@demo.test", phone: "9820000001", type: "staff", role: "platform_admin" },
  { key: "support", name: "Sana Qureshi", email: "support@demo.test", phone: "9820000002", type: "staff", role: "support_agent" },
  { key: "production", name: "Prakash Nair", email: "production@demo.test", phone: "9820000003", type: "staff", role: "production_staff" },
  { key: "priya", name: "Priya Sharma", email: "priya@demo.test", phone: "9820000010", type: "individual", role: "customer" },
  { key: "anjali", name: "Anjali Rao", email: "anjali@acme.test", phone: "9820000020", type: "business" },
  { key: "rahul", name: "Rahul Verma", email: "rahul@acme.test", phone: "9820000021", type: "business" },
  { key: "vikram", name: "Vikram Joshi", email: "vikram@globex.test", phone: "9820000030", type: "business" },
  { key: "ravi", name: "Ravi Kumar", email: "ravi@stitchline.test", phone: "9820000040", type: "vendor" },
  { key: "stitchstaff", name: "Lakshmi Iyer", email: "staff@stitchline.test", phone: "9820000041", type: "vendor" },
  { key: "meena", name: "Meena Gupta", email: "meena@bagcraft.test", phone: "9820000050", type: "vendor" },
  { key: "arjun", name: "Arjun Singh", email: "arjun@craftwood.test", phone: "9820000060", type: "vendor" },
  { key: "kiran", name: "Kiran Patil", email: "kiran@printpro.test", phone: "9820000070", type: "vendor" },
];

const COMPANIES = [
  { key: "acme", name: "Acme Technologies Pvt Ltd", gstin: "29AABCA1234F1Z5", pan: "AABCA1234F", industry: "Software", size: "201-1000",
    address: { line1: "12 Outer Ring Road, Bellandur", city: "Bengaluru", state: "Karnataka", pincode: "560103" },
    terms: "advance_50", approvalLimit: 50000, members: [["anjali", "admin"], ["rahul", "buyer"]] },
  { key: "globex", name: "Globex Industries Ltd", gstin: "27AACCG5678K1Z2", pan: "AACCG5678K", industry: "Manufacturing", size: "1000+",
    address: { line1: "Plot 22, MIDC Andheri East", city: "Mumbai", state: "Maharashtra", pincode: "400093" },
    terms: "credit_30", credit: true, creditLimit: 1000000, members: [["vikram", "admin"]], keyAccount: true },
];

const VENDORS = [
  { key: "stitchline", owner: "ravi", staff: ["stitchstaff"], name: "Stitchline Embroidery Works", type: "fulfilment_partner", status: "approved", gstin: "33AAKFS4321L1Z8", pan: "AAKFS4321L",
    city: "Tiruppur", state: "Tamil Nadu", pincode: "641604", capacity: 800, commission: 0, quality: 4.6, prefixes: ["6", "5"],
    caps: [["embroidery", 25, 5000, 600, 5, 40], ["screen_print", 50, 10000, 1500, 4, 18]], machines: "6-head Tajima embroidery x2, 4-colour manual screen press" },
  { key: "bagcraft", slug: "bagcraft-studio", owner: "meena", name: "BagCraft Studio", type: "both", status: "approved", gstin: "07AAHCB9876M1Z3", pan: "AAHCB9876M",
    city: "New Delhi", state: "Delhi", pincode: "110020", capacity: 300, commission: 18, quality: 4.3, prefixes: ["1", "2"],
    caps: [["screen_print", 25, 3000, 400, 5, 25], ["embroidery", 10, 1000, 150, 6, 55]], machines: "Automatic bag screen printer" },
  { key: "craftwood", slug: "craftwood-gifts", owner: "arjun", name: "Craftwood Gifts", type: "marketplace_seller", status: "approved", gstin: "08AAFCC1111N1Z6", pan: "AAFCC1111N",
    city: "Jaipur", state: "Rajasthan", pincode: "302001", capacity: 200, commission: 15, quality: 4.7, prefixes: ["3"],
    caps: [["laser_engraving", 1, 2000, 300, 3, 18]], machines: "60W CO2 laser engraver" },
  { key: "printpro", owner: "kiran", name: "PrintPro Solutions", type: "fulfilment_partner", status: "under_review", gstin: "29AAICP2222Q1Z1", pan: "AAICP2222Q",
    city: "Bengaluru", state: "Karnataka", pincode: "560058", capacity: 1000, commission: 0, quality: 4.5, prefixes: ["5"],
    caps: [["uv_print", 1, 5000, 1000, 3, 35], ["dtf", 1, 3000, 800, 3, 50]], machines: "Mimaki UV flatbed, DTF printer" },
];

function variantRows(def, productId) {
  const sizes = def.sizes || [null];
  const rows = [];
  let i = 0;
  for (const color of def.colors) {
    for (const size of sizes) {
      i++;
      const attrs = { color: COLOR_NAME[color] };
      if (size) attrs.size = size;
      if (def.material) attrs.material = def.material;
      const sku = `${def.slug.split("-").map((w) => w[0]).join("").toUpperCase().slice(0, 5)}-${color.slice(0, 3).toUpperCase()}${size ? "-" + size.replace(/\s/g, "").toUpperCase() : ""}`;
      // Demo stock: a few lines deliberately low so the low-stock report has data.
      const stock = def.type === "kit" ? 0 : (i % 7 === 0 ? 6 : 40 + ((i * 37) % 160));
      rows.push({
        product_id: productId,
        sku,
        attributes: attrs,
        color_hex: COLOR_HEX[color],
        image: IMG(def.type, color),
        cost_adjust_paise: size === "XXL" ? rupees(20) : 0,
        track_inventory: def.type !== "kit",
        stock_qty: stock,
        low_stock_threshold: 10,
      });
    }
  }
  return rows;
}

async function createProduct(def, ctx, transaction, extra = {}) {
  const category = ctx.categories[def.category];
  const product = await Product.create(
    {
      category_id: category.id,
      source_type: extra.source_type || "own",
      vendor_id: extra.vendor_id || null,
      name: def.name,
      slug: def.slug,
      short_description: def.short,
      description:
        `${def.short}\n\nAdd your logo, photo or text in the customisation studio and preview it before you order. ` +
        `Every customised order gets a digital proof for your approval before production starts.`,
      images: def.colors.map((c) => IMG(def.type, c)),
      base_cost_paise: rupees(def.base),
      packaging_cost_paise: rupees(def.pack),
      hsn_code: def.hsn,
      gst_rate: def.gst,
      moq: def.moq,
      max_instant_qty: extra.max_instant_qty || 499,
      lead_time_days: def.lead,
      weight_grams: def.weight,
      specifications: { Material: def.material, "Print methods": def.methods.map((m) => ctx.methods[m[0]].name).join(", ") },
      care_instructions: def.type === "mug" ? "Dishwasher safe. Microwave safe (not for magic mugs)." : def.sizes ? "Machine wash cold, inside out. Do not iron on print." : null,
      occasions: def.occasions || [],
      tags: def.tags || [],
      is_customisable: true,
      supports_live_preview: def.livePreview !== false,
      status: "active",
      is_featured: Boolean(def.featured),
      is_demo: true,
      created_by: ctx.users.admin.id,
    },
    { transaction }
  );
  await ProductVariant.bulkCreate(variantRows(def, product.id), { transaction });
  await PrintArea.bulkCreate(
    def.areas.map(([code, name, w, h, box], i) => ({
      product_id: product.id,
      code,
      name,
      width_mm: w,
      height_mm: h,
      box,
      allowed_methods: def.methods.map((m) => m[0]),
      max_text_chars: Math.max(12, Math.round(w / 4)),
      sort_order: i,
    })),
    { transaction }
  );
  await ProductMethod.bulkCreate(
    def.methods.map(([code, cost, setup, moq, isDefault]) => ({
      product_id: product.id,
      method_id: ctx.methods[code].id,
      cost_per_unit_paise: rupees(cost),
      setup_fee_paise: rupees(setup),
      moq,
      is_default: isDefault,
    })),
    { transaction }
  );
  if (extra.tiers) {
    await PriceTier.bulkCreate(extra.tiers.map((t) => ({ ...t, product_id: product.id })), { transaction });
  } else {
    await PriceTier.bulkCreate(
      [
        { min_qty: 1, max_qty: 9, margin_pct: 60, checkout_path: "instant" },
        { min_qty: 10, max_qty: 49, margin_pct: 50, checkout_path: "instant" },
        { min_qty: 50, max_qty: 99, margin_pct: 42, checkout_path: "instant" },
        { min_qty: 100, max_qty: 499, margin_pct: 35, checkout_path: "instant_or_quote" },
        { min_qty: 500, max_qty: null, margin_pct: 28, checkout_path: "quote_only" },
      ].map((t) => ({ ...t, product_id: product.id })),
      { transaction }
    );
  }
  // Fulfilment sources: in-house for in-house methods, partners for the rest.
  const inHouse = def.methods.some((m) => ctx.methods[m[0]].in_house);
  if (!extra.vendor_id && inHouse) {
    await ProductSource.create({ product_id: product.id, source: "in_house", cost_paise: rupees(def.base), lead_time_days: def.lead, is_default: true }, { transaction });
  }
  let hasDefault = !extra.vendor_id && inHouse;
  for (const vendor of Object.values(ctx.vendors)) {
    if (vendor.status !== "approved") continue;
    // A marketplace listing is fulfilled only by the vendor that lists it.
    if (extra.vendor_id && extra.vendor_id !== vendor.id) continue;
    const caps = ctx.vendorCaps[vendor.id] || [];
    if (!extra.vendor_id && !def.methods.some((m) => caps.includes(m[0]))) continue;
    await ProductSource.create(
      { product_id: product.id, source: "vendor", vendor_id: vendor.id, cost_paise: rupees(def.base * 1.05), lead_time_days: def.lead + 1, is_default: !hasDefault },
      { transaction }
    );
    hasDefault = true;
  }
  return product;
}

async function seedDemo() {
  const exists = await User.findOne({ where: { email: "admin@demo.test" }, paranoid: false });
  if (exists) {
    console.log("Demo data already present (admin@demo.test exists). Run `npm run seed:demo:remove` first to recreate it.");
    return;
  }
  const passwordHash = await hashPassword(DEMO_PASSWORD);
  await sequelize.transaction(async (transaction) => {
    const ctx = { users: {}, companies: {}, vendors: {}, vendorCaps: {}, categories: {}, methods: {}, products: {} };
    for (const m of await DecorationMethod.findAll({ transaction })) ctx.methods[m.code] = m;

    // ---- Users
    for (const u of USERS) {
      ctx.users[u.key] = await User.create(
        { name: u.name, email: u.email, phone: u.phone, password_hash: passwordHash, account_type: u.type, status: "active", email_verified_at: new Date(), is_demo: true },
        { transaction }
      );
      if (u.role) await authService.assignRole(ctx.users[u.key].id, u.role, u.role === "customer" ? "self" : "platform", null, transaction);
    }
    await Address.create(
      { user_id: ctx.users.priya.id, label: "Home", contact_name: "Priya Sharma", phone: "9820000010", line1: "Flat 502, Sea Breeze CHS, Carter Road", line2: "Bandra West", city: "Mumbai", state: "Maharashtra", pincode: "400050", is_default: true },
      { transaction }
    );

    // ---- Companies
    for (const c of COMPANIES) {
      const company = await Company.create(
        {
          name: c.name, legal_name: c.name, gstin: c.gstin, pan: c.pan, industry: c.industry, company_size: c.size,
          billing_email: `accounts@${c.key}.test`, billing_phone: "9820099999", billing_address: c.address,
          payment_terms: c.terms, credit_approved: Boolean(c.credit), credit_limit_paise: rupees(c.creditLimit || 0),
          approval_limit_paise: rupees(c.approvalLimit || 0), is_key_account: Boolean(c.keyAccount), is_demo: true,
        },
        { transaction }
      );
      ctx.companies[c.key] = company;
      for (const [userKey, memberRole] of c.members) {
        const user = ctx.users[userKey];
        await CompanyMember.create({ company_id: company.id, user_id: user.id, member_role: memberRole }, { transaction });
        await authService.assignRole(user.id, { admin: "business_admin", buyer: "business_buyer", approver: "business_approver" }[memberRole], "company", company.id, transaction);
      }
      await Address.create(
        { company_id: company.id, label: "Head office", contact_name: ctx.users[c.members[0][0]].name, phone: "9820099999", ...c.address, is_default: true },
        { transaction }
      );
    }

    // ---- Vendors
    for (const v of VENDORS) {
      const vendor = await Vendor.create(
        {
          owner_user_id: ctx.users[v.owner].id, business_name: v.name, legal_name: v.name, vendor_type: v.type, gstin: v.gstin, pan: v.pan,
          bank_account_name: v.name, bank_account_last4: "4321", bank_account_number_enc: encrypt("001234564321"), bank_ifsc: "HDFC0001234",
          contact_email: ctx.users[v.owner].email, contact_phone: ctx.users[v.owner].phone,
          address: { line1: "Industrial area", city: v.city, state: v.state, pincode: v.pincode }, pincode: v.pincode,
          service_pincode_prefixes: v.prefixes, machines: v.machines, daily_capacity: v.capacity, status: v.status,
          commission_pct: v.commission, quality_score: v.quality, approved_at: v.status === "approved" ? new Date() : null,
          approved_by: v.status === "approved" ? ctx.users.admin.id : null, is_demo: true,
        },
        { transaction }
      );
      ctx.vendors[v.slug || v.key] = vendor;
      await VendorUser.create({ vendor_id: vendor.id, user_id: ctx.users[v.owner].id, member_role: "admin" }, { transaction });
      await authService.assignRole(ctx.users[v.owner].id, "vendor_admin", "vendor", vendor.id, transaction);
      for (const s of v.staff || []) {
        await VendorUser.create({ vendor_id: vendor.id, user_id: ctx.users[s].id, member_role: "staff" }, { transaction });
        await authService.assignRole(ctx.users[s].id, "vendor_staff", "vendor", vendor.id, transaction);
      }
      ctx.vendorCaps[vendor.id] = v.caps.map((c) => c[0]);
      for (const [code, min, max, cap, lead, cost] of v.caps) {
        await VendorCapability.create(
          { vendor_id: vendor.id, method_id: ctx.methods[code].id, min_qty: min, max_qty: max, daily_capacity: cap, lead_time_days: lead, cost_per_unit_paise: rupees(cost), quality_score: v.quality },
          { transaction }
        );
      }
    }
    await Company.update({ preferred_vendor_id: ctx.vendors.stitchline.id }, { where: { id: ctx.companies.globex.id }, transaction });

    // ---- Categories
    for (const c of CATEGORIES) {
      const parent = await Category.create(
        { name: c.name, slug: c.slug, description: c.description, image: c.image, default_lead_time_days: c.lead, sort_order: c.sort, is_demo: true },
        { transaction }
      );
      ctx.categories[c.slug] = parent;
      let i = 0;
      for (const child of c.children) {
        ctx.categories[child.slug] = await Category.create(
          { name: child.name, slug: child.slug, parent_id: parent.id, image: c.image, default_lead_time_days: c.lead, sort_order: ++i, is_demo: true },
          { transaction }
        );
      }
    }

    // ---- Products
    for (const def of PRODUCTS) ctx.products[def.slug] = await createProduct(def, ctx, transaction);
    for (const def of VENDOR_LISTINGS) {
      const vendor = ctx.vendors[def.vendor];
      ctx.products[def.slug] = await createProduct(def, ctx, transaction, { source_type: "vendor_listing", vendor_id: vendor.id, tiers: VENDOR_TIERS, max_instant_qty: 199 });
    }
    for (const kit of KITS) {
      const components = kit.components.map(([slug, qty]) => [ctx.products[slug], qty]);
      const baseCost = components.reduce((s, [p, q]) => s + p.base_cost_paise * q, 0);
      const def = {
        ...kit, category: "corporate-gift-kits", base: baseCost / 100, weight: 1500, colors: [kit.color], livePreview: false,
        material: "Rigid gift box with branded sleeve", methods: [["uv_print", 120, 0, 25, true], ["screen_print", 40, 2500, 50, false]],
        areas: [["lid", "Box lid", 200, 120, { x: 25, y: 38, w: 50, h: 12 }]],
      };
      const product = await createProduct(def, ctx, transaction, { source_type: "kit", max_instant_qty: 199 });
      for (const [component, quantity] of components) {
        await BundleItem.create({ kit_product_id: product.id, component_product_id: component.id, quantity }, { transaction });
      }
    }

    // Opening stock movements
    const variants = await ProductVariant.findAll({ where: { track_inventory: true }, transaction });
    await InventoryMovement.bulkCreate(
      variants.map((v) => ({ variant_id: v.id, change_qty: v.stock_qty, balance_after: v.stock_qty, reason: "initial", note: "Demo opening stock", created_by: ctx.users.admin.id })),
      { transaction }
    );

    // ---- Coupons
    await Coupon.bulkCreate(
      [
        { code: "WELCOME10", description: "10% off your first order (up to ₹200)", discount_type: "percent", value: 10, min_order_paise: rupees(499), max_discount_paise: rupees(200), applies_to: "b2c", per_user_limit: 1 },
        { code: "FLAT100", description: "₹100 off orders above ₹999", discount_type: "flat", value: 100, min_order_paise: rupees(999), applies_to: "all", per_user_limit: 3 },
        { code: "BULK5", description: "5% off business orders above ₹20,000", discount_type: "percent", value: 5, min_order_paise: rupees(20000), max_discount_paise: rupees(5000), applies_to: "b2b", per_user_limit: 10 },
      ],
      { transaction }
    );
    // Link demo products to the tax master (seeded with the reference data).
    await sequelize.query(
      `UPDATE products p SET tax_rate_id = t.id FROM tax_rates t WHERE p.tax_rate_id IS NULL AND p.is_demo AND t.rate = p.gst_rate AND t.is_active`,
      { transaction }
    );
    const blogPosts = await require("./demoBlog").seedDemoBlog(ctx, transaction);
    console.log(`Demo data: ${USERS.length} users, ${COMPANIES.length} companies, ${VENDORS.length} vendors, ${Object.keys(ctx.products).length + KITS.length} products, ${blogPosts} blog posts`);
  });
}

async function removeDemo() {
  await sequelize.transaction(async (transaction) => {
    const q = (sql) => sequelize.query(sql, { transaction });
    const demoUsers = "SELECT id FROM users WHERE is_demo";
    const demoOrders = `SELECT id FROM orders WHERE is_demo OR user_id IN (${demoUsers})`;
    await q(`DELETE FROM settlement_lines WHERE settlement_id IN (SELECT id FROM settlements WHERE vendor_id IN (SELECT id FROM vendors WHERE is_demo))`);
    await q(`DELETE FROM commissions WHERE vendor_id IN (SELECT id FROM vendors WHERE is_demo) OR order_item_id IN (SELECT id FROM order_items WHERE order_id IN (${demoOrders}))`);
    await q(`DELETE FROM settlements WHERE vendor_id IN (SELECT id FROM vendors WHERE is_demo)`);
    await q(`DELETE FROM refunds WHERE order_id IN (${demoOrders})`);
    await q(`DELETE FROM ticket_messages WHERE ticket_id IN (SELECT id FROM tickets WHERE user_id IN (${demoUsers}) OR order_id IN (${demoOrders}))`);
    await q(`DELETE FROM tickets WHERE user_id IN (${demoUsers}) OR order_id IN (${demoOrders})`);
    await q(`DELETE FROM reviews WHERE user_id IN (${demoUsers}) OR product_id IN (SELECT id FROM products WHERE is_demo)`);
    await q(`UPDATE quotes SET order_id = NULL WHERE order_id IN (${demoOrders})`);
    await q(`UPDATE order_items SET approved_proof_id = NULL, reprint_of_item_id = NULL WHERE order_id IN (${demoOrders})`);
    await q(`DELETE FROM orders WHERE id IN (${demoOrders})`);
    await q(`UPDATE quotes SET current_version_id = NULL WHERE requester_user_id IN (${demoUsers})`);
    await q(`DELETE FROM quotes WHERE requester_user_id IN (${demoUsers})`);
    await q(`UPDATE designs SET current_version_id = NULL WHERE user_id IN (${demoUsers})`);
    await q(`DELETE FROM designs WHERE user_id IN (${demoUsers})`);
    await q(`DELETE FROM carts WHERE user_id IN (${demoUsers})`);
    await q(`DELETE FROM coupon_redemptions WHERE user_id IN (${demoUsers})`);
    await q(`DELETE FROM coupons WHERE code IN ('WELCOME10','FLAT100','BULK5')`);
    await q(`DELETE FROM inventory_movements WHERE variant_id IN (SELECT pv.id FROM product_variants pv JOIN products p ON p.id = pv.product_id WHERE p.is_demo)`);
    await q(`DELETE FROM bundle_items WHERE kit_product_id IN (SELECT id FROM products WHERE is_demo)`);
    await q(`DELETE FROM wishlists WHERE product_id IN (SELECT id FROM products WHERE is_demo) OR user_id IN (${demoUsers})`);
    await q(`DELETE FROM products WHERE is_demo`);
    await q(`DELETE FROM categories WHERE is_demo AND parent_id IS NOT NULL`);
    await q(`DELETE FROM categories WHERE is_demo`);
    await q(`UPDATE companies SET preferred_vendor_id = NULL WHERE is_demo`);
    await q(`DELETE FROM vendors WHERE is_demo`);
    await q(`DELETE FROM companies WHERE is_demo`);
    await q(`DELETE FROM artwork_assets WHERE owner_user_id IN (${demoUsers})`);
    await q(`DELETE FROM blog_posts WHERE author_id IN (${demoUsers}) OR created_by IN (${demoUsers})`);
    await q(`UPDATE blog_posts SET updated_by = NULL WHERE updated_by IN (${demoUsers})`);
    await q(`UPDATE blog_posts SET reviewed_by = NULL WHERE reviewed_by IN (${demoUsers})`);
    await q(`DELETE FROM audit_logs WHERE actor_user_id IN (${demoUsers})`);
    await q(`UPDATE settings SET updated_by = NULL WHERE updated_by IN (${demoUsers})`);
    await q(`UPDATE cms_pages SET updated_by = NULL WHERE updated_by IN (${demoUsers})`);
    await q(`DELETE FROM users WHERE is_demo`);
  });
  console.log("Demo data removed");
}

module.exports = { seedDemo, removeDemo, DEMO_PASSWORD };
