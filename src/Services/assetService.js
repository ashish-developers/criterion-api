// Artwork and file uploads (FR-ST-01) with private, access-controlled retrieval.
const { sequelize, ArtworkAsset } = require("../Models");
const ApiError = require("../Utils/ApiError");
const { sha256 } = require("../Utils/crypto");
const storage = require("./storageService");
const inspector = require("./fileInspector");

// Which file types each upload kind accepts, and who may upload it.
const KINDS = {
  artwork: { types: ["png", "jpg", "svg", "pdf"], permission: null },
  preview: { types: ["png", "jpg"], permission: null },
  complaint_photo: { types: ["png", "jpg"], permission: null },
  document: { types: ["pdf", "png", "jpg"], permission: null },
  production_photo: { types: ["png", "jpg"], permission: ["vendor.jobs.update", "production.manage"] },
  qc_photo: { types: ["png", "jpg"], permission: ["vendor.jobs.update", "qc.perform"] },
  proof: { types: ["png", "jpg", "pdf"], permission: ["proofs.manage"] },
  print_file: { types: ["png", "pdf", "svg"], permission: ["proofs.manage"] },
  product_image: { types: ["png", "jpg", "svg"], permission: ["catalogue.manage", "vendor.listings.manage"] },
  // Featured, social and in-article blog images. Raster only: SVG is never embedded in posts.
  blog_image: { types: ["png", "jpg", "webp"], permission: ["blog.create", "blog.edit_own", "blog.edit_all"], maxMb: 5 },
};

// Served without sign-in (storefront and blog pages).
const PUBLIC_KINDS = ["product_image", "blog_image"];

async function upload(auth, file, { kind = "artwork", companyAsset = false, brandKitId = null } = {}) {
  if (!file) throw ApiError.badRequest("Choose a file to upload", undefined, "FILE_REQUIRED");
  const def = KINDS[kind];
  if (!def) throw ApiError.badRequest("Unknown upload type", undefined, "KIND_INVALID");
  if (def.permission && !def.permission.some((p) => auth.permissions.has(p))) throw ApiError.forbidden();
  if (companyAsset && !auth.permissions.has("company.brand.manage")) throw ApiError.forbidden("Only company admins can add brand assets");

  const detected = inspector.detectType(file.buffer);
  if (!detected || !def.types.includes(detected.ext)) {
    throw ApiError.unprocessable(
      `This file type is not supported. Upload ${def.types.map((t) => t.toUpperCase()).join(", ")}.`,
      "FILE_TYPE_REJECTED"
    );
  }
  if (def.maxMb && file.size > def.maxMb * 1024 * 1024) {
    throw ApiError.unprocessable(`Images must be ${def.maxMb} MB or smaller`, "FILE_TOO_LARGE");
  }
  const scan = inspector.scan(file.buffer, detected.ext);
  if (!scan.clean) throw ApiError.unprocessable(scan.reason, "FILE_REJECTED_BY_SCAN");

  const { width, height } = inspector.dimensions(file.buffer, detected.ext);
  const key = await storage.put(file.buffer, detected.ext);
  const asset = await ArtworkAsset.create({
    owner_user_id: auth.user.id,
    company_id: companyAsset ? auth.companyId : null,
    brand_kit_id: companyAsset ? brandKitId : null,
    kind,
    original_name: String(file.originalname || `upload.${detected.ext}`).replace(/[^\w.\- ()]/g, "_").slice(0, 200),
    storage_key: key,
    mime_type: detected.mime,
    size_bytes: file.size,
    width_px: width,
    height_px: height,
    checksum: sha256(file.buffer),
    scan_status: "clean",
    is_public: PUBLIC_KINDS.includes(kind),
  });
  return present(asset);
}

function present(asset) {
  return {
    id: asset.id,
    kind: asset.kind,
    name: asset.original_name,
    mimeType: asset.mime_type,
    sizeBytes: asset.size_bytes,
    width: asset.width_px,
    height: asset.height_px,
    isVector: ["image/svg+xml", "application/pdf"].includes(asset.mime_type),
    url: `/api/v1/assets/${asset.id}`,
    createdAt: asset.created_at,
  };
}

const STAFF_VIEW = ["orders.view", "production.view", "proofs.manage", "catalogue.manage", "tickets.manage", "quotes.view"];

// Vendors only see files belonging to jobs assigned to them (Section 11.2).
async function vendorCanSee(vendorId, assetId) {
  const [rows] = await sequelize.query(
    `SELECT 1 FROM production_jobs j
       JOIN order_items oi ON oi.id = j.order_item_id
       LEFT JOIN proofs pr ON pr.id = j.proof_id
       LEFT JOIN design_versions dv ON dv.id = oi.design_version_id
      WHERE j.vendor_id = :vendorId AND j.status NOT IN ('rejected','cancelled')
        AND (pr.preview_asset_id = :assetId OR pr.print_file_asset_id = :assetId
             OR dv.preview_asset_id = :assetId OR :assetId = ANY(dv.asset_ids)
             OR EXISTS (SELECT 1 FROM job_events e WHERE e.job_id = j.id AND :assetId = ANY(e.photo_asset_ids))
             OR EXISTS (SELECT 1 FROM qc_checks q WHERE q.job_id = j.id AND :assetId = ANY(q.photo_asset_ids)))
      LIMIT 1`,
    { replacements: { vendorId, assetId } }
  );
  return rows.length > 0;
}

// Buyers see proofs, print files and production/QC photos for their own (or company) orders,
// and attachments on their own tickets.
async function buyerCanSee(auth, assetId) {
  const [rows] = await sequelize.query(
    `SELECT 1 FROM orders o
       JOIN order_items oi ON oi.order_id = o.id
      WHERE (o.user_id = :userId OR (o.company_id IS NOT NULL AND o.company_id = :companyId))
        AND (EXISTS (SELECT 1 FROM proofs pr WHERE pr.order_item_id = oi.id AND (pr.preview_asset_id = :assetId OR pr.print_file_asset_id = :assetId))
             OR EXISTS (SELECT 1 FROM design_versions dv WHERE dv.id = oi.design_version_id AND (dv.preview_asset_id = :assetId OR :assetId = ANY(dv.asset_ids)))
             OR EXISTS (SELECT 1 FROM production_jobs j JOIN job_events e ON e.job_id = j.id WHERE j.order_item_id = oi.id AND :assetId = ANY(e.photo_asset_ids))
             OR EXISTS (SELECT 1 FROM production_jobs j JOIN qc_checks q ON q.job_id = j.id WHERE j.order_item_id = oi.id AND :assetId = ANY(q.photo_asset_ids)))
     UNION ALL
     SELECT 1 FROM tickets t JOIN ticket_messages m ON m.ticket_id = t.id
      WHERE t.user_id = :userId AND :assetId = ANY(m.attachment_asset_ids)
     UNION ALL
     SELECT 1 FROM quotes q JOIN quote_request_items qi ON qi.quote_id = q.id
      WHERE (q.requester_user_id = :userId OR (q.company_id IS NOT NULL AND q.company_id = :companyId)) AND :assetId = ANY(qi.artwork_asset_ids)
     LIMIT 1`,
    { replacements: { userId: auth.user.id, companyId: auth.companyId || "00000000-0000-0000-0000-000000000000", assetId } }
  );
  return rows.length > 0;
}

async function canAccess(auth, asset) {
  if (asset.is_public) return true;
  if (!auth) return false;
  if (asset.owner_user_id === auth.user.id) return true;
  if (asset.company_id && asset.company_id === auth.companyId) return true;
  if (STAFF_VIEW.some((p) => auth.permissions.has(p))) return true;
  if (auth.vendorId && (await vendorCanSee(auth.vendorId, asset.id))) return true;
  return buyerCanSee(auth, asset.id);
}

async function getForDownload(auth, id) {
  const asset = await ArtworkAsset.findByPk(id);
  // Same response for missing and forbidden files, so IDs cannot be probed.
  if (!asset || !(await canAccess(auth, asset))) throw ApiError.notFound("File not found");
  const buffer = await storage.read(asset.storage_key);
  return { asset, buffer };
}

async function assertUsable(auth, assetIds) {
  if (!assetIds || !assetIds.length) return [];
  const assets = await ArtworkAsset.findAll({ where: { id: assetIds } });
  if (assets.length !== new Set(assetIds).size) throw ApiError.unprocessable("One of the files could not be found", "ASSET_NOT_FOUND");
  for (const asset of assets) {
    if (!(await canAccess(auth, asset))) throw ApiError.unprocessable("One of the files could not be found", "ASSET_NOT_FOUND");
  }
  return assets;
}

async function listMine(auth, { kind, companyOnly = false } = {}) {
  const where = companyOnly ? { company_id: auth.companyId } : { owner_user_id: auth.user.id };
  if (kind) where.kind = kind;
  const assets = await ArtworkAsset.findAll({ where, order: [["created_at", "DESC"]], limit: 100 });
  return assets.map(present);
}

module.exports = { upload, present, canAccess, getForDownload, assertUsable, listMine, KINDS };
