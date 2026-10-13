// DEMONSTRATION blog content: categories, tags, a handful of posts in different workflow
// states, and the Contributor blog preset granted to the demo production user.
// Posts belong to demo users, so `npm run seed:demo:remove` deletes them.
const { BlogCategory, BlogTag, BlogPost, BlogPostTag, BlogPostHistory, Permission, UserPermission } = require("../Models");
const { sanitize, toText } = require("../Services/blogContent");
const { BLOG_PRESETS } = require("../Config/roles");

const CATEGORIES = [
  { name: "Gift ideas", slug: "gift-ideas", description: "Personalised gift ideas for every occasion", sort_order: 1 },
  { name: "Corporate gifting", slug: "corporate-gifting", description: "Welcome kits, client gifts and branded merchandise", sort_order: 2 },
  { name: "Guides", slug: "guides", description: "Artwork, printing and ordering how-tos", sort_order: 3 },
];

const TAGS = ["Diwali", "Onboarding", "Artwork", "Embroidery", "Sustainability", "Employee engagement"];

const DAY = 24 * 60 * 60 * 1000;

const POSTS = [
  {
    title: "12 personalised Diwali gift ideas your team will actually use",
    slug: "personalised-diwali-gift-ideas",
    category: "gift-ideas",
    tags: ["Diwali", "Employee engagement"],
    author: "admin",
    status: "published",
    featured: true,
    daysAgo: 3,
    excerpt: "From engraved bottles to custom hampers: practical Diwali gifts that carry your brand into homes all year.",
    content: `<p>Festive gifting works best when the gift earns a place on someone's desk or kitchen shelf long after the season ends. Here are our most re-ordered Diwali picks.</p>
<h2>Everyday essentials</h2>
<ul><li><strong>Insulated steel bottles</strong> with laser engraving that never fades.</li><li><strong>Ceramic mugs</strong> with full-wrap sublimation prints.</li><li><strong>Cotton tote bags</strong> screen-printed in your brand colours.</li></ul>
<h2>Premium hampers</h2>
<p>Pair a <em>wooden desk organiser</em> with dry fruits and a handwritten card for senior leaders and key clients.</p>
<blockquote>Order at least three weeks before Diwali: proofs, production and dispatch take time during the festive rush.</blockquote>
<h3>Lead times at a glance</h3>
<table><thead><tr><th>Product</th><th>Typical lead time</th></tr></thead><tbody><tr><td>Engraved bottles</td><td>5 to 7 days</td></tr><tr><td>Printed mugs</td><td>3 to 5 days</td></tr><tr><td>Gift hampers</td><td>7 to 10 days</td></tr></tbody></table>`,
  },
  {
    title: "How to build an employee welcome kit that makes day one memorable",
    slug: "employee-welcome-kit-guide",
    category: "corporate-gifting",
    tags: ["Onboarding", "Employee engagement"],
    author: "admin",
    status: "published",
    daysAgo: 10,
    excerpt: "A practical checklist for onboarding kits: what to include, how to brand it, and how to ship to remote hires.",
    content: `<p>A welcome kit is often a new hire's first physical touchpoint with your company. Done well, it says <strong>we were expecting you</strong>.</p>
<h2>What to include</h2>
<ol><li>A notebook and pen set with your logo.</li><li>A t-shirt or hoodie (collect sizes during offer acceptance).</li><li>A bottle or mug for the desk.</li><li>A short welcome note from the team lead.</li></ol>
<h2>Shipping to remote hires</h2>
<p>Upload a recipient list with sizes and addresses and we'll ship each kit individually. See our <a href="/corporate">corporate gifting page</a> for bulk pricing.</p>`,
  },
  {
    title: "Preparing artwork for print: a five-minute checklist",
    slug: "artwork-print-checklist",
    category: "guides",
    tags: ["Artwork"],
    author: "admin",
    status: "published",
    daysAgo: 21,
    excerpt: "Resolution, colour, bleed and file formats explained, so your proof comes back right first time.",
    content: `<p>Most proof revisions come down to a handful of artwork issues. Check these before you upload.</p>
<h2>Resolution</h2>
<p>Raster images should be at least <strong>300 DPI</strong> at the printed size. Our studio warns you when an upload is too small.</p>
<h2>File formats</h2>
<ul><li>Vector (SVG or PDF) for logos: they scale without losing quality.</li><li>PNG with a transparent background for photos and illustrations.</li></ul>
<h2>Colour</h2>
<p>Screens show RGB; printers use CMYK or spot colours. Expect slight shifts on bright greens and blues.</p>`,
  },
  {
    title: "Embroidery or screen print? Choosing the right decoration method",
    slug: "embroidery-vs-screen-print",
    category: "guides",
    tags: ["Embroidery", "Artwork"],
    author: "admin",
    status: "scheduled",
    scheduleInDays: 2,
    excerpt: "Durability, cost and detail compared for the two most popular apparel decoration methods.",
    content: `<p>Both methods last, but they suit different designs and budgets.</p><h2>Embroidery</h2><p>Premium, textured and durable. Best for small logos on polos, caps and jackets.</p><h2>Screen printing</h2><p>Cost-effective at volume and great for large, bold artwork on t-shirts and totes.</p>`,
  },
  {
    title: "Sustainable merchandise that people keep",
    slug: "sustainable-merchandise",
    category: "corporate-gifting",
    tags: ["Sustainability"],
    author: "production",
    status: "pending_approval",
    excerpt: "Recycled, organic and reusable: merchandise choices that reduce waste without looking like a compromise.",
    content: `<p>The most sustainable merchandise is the kind that gets used. Choose durable products, avoid single-use items and print with water-based inks where possible.</p>`,
  },
  {
    title: "Draft: Festive packaging ideas",
    slug: "festive-packaging-ideas",
    category: "gift-ideas",
    tags: [],
    author: "production",
    status: "draft",
    content: `<p>Outline: kraft boxes, branded sleeves, seed-paper tags…</p>`,
  },
];

async function seedDemoBlog(ctx, transaction) {
  const categories = {};
  for (const c of CATEGORIES) {
    const [row] = await BlogCategory.findOrCreate({ where: { slug: c.slug }, defaults: c, transaction });
    categories[c.slug] = row;
  }
  const tags = {};
  for (const name of TAGS) {
    const slug = name.toLowerCase().replace(/[^a-z0-9]+/g, "-");
    const [row] = await BlogTag.findOrCreate({ where: { slug }, defaults: { name, slug }, transaction });
    tags[name] = row;
  }

  const now = Date.now();
  for (const def of POSTS) {
    const author = ctx.users[def.author];
    const html = sanitize(def.content);
    const publishedAt = def.status === "published" ? new Date(now - def.daysAgo * DAY) : null;
    const post = await BlogPost.create(
      {
        title: def.title,
        slug: def.slug,
        excerpt: def.excerpt || null,
        content: html,
        content_text: toText(html),
        author_id: author.id,
        created_by: author.id,
        category_id: categories[def.category]?.id || null,
        status: def.status,
        is_featured: Boolean(def.featured),
        published_at: publishedAt,
        scheduled_at: def.status === "scheduled" ? new Date(now + def.scheduleInDays * DAY) : null,
        submitted_at: def.status === "pending_approval" ? new Date(now - DAY) : null,
        view_count: publishedAt ? 40 + Math.round((30 - def.daysAgo) * 7) : 0,
      },
      { transaction }
    );
    if (def.tags.length) await BlogPostTag.bulkCreate(def.tags.map((t) => ({ post_id: post.id, tag_id: tags[t].id })), { transaction });
    await BlogPostHistory.create({ post_id: post.id, actor_user_id: author.id, action: "created", to_status: "draft" }, { transaction });
    if (def.status !== "draft") {
      await BlogPostHistory.create({ post_id: post.id, actor_user_id: author.id, action: def.status === "pending_approval" ? "submit" : def.status === "scheduled" ? "schedule" : "publish", from_status: "draft", to_status: def.status }, { transaction });
    }
  }

  // The demo production user writes drafts and submits them for approval.
  const perms = await Permission.findAll({ where: { code: BLOG_PRESETS.contributor.permissions }, transaction });
  await UserPermission.bulkCreate(perms.map((p) => ({ user_id: ctx.users.production.id, permission_id: p.id, granted_by: ctx.users.admin.id })), { transaction });
  return POSTS.length;
}

module.exports = { seedDemoBlog };
