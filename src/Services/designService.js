// Saved designs and immutable design versions (FR-ST-02..06).
// A version stores the canvas JSON (layers per print area) plus references to the
// original artwork; the browser renders a PNG preview which is uploaded and linked.
const { Op } = require("sequelize");
const { sequelize, Design, DesignVersion, Product, ProductVariant, PrintArea, ArtworkAsset } = require("../Models");
const ApiError = require("../Utils/ApiError");
const inspector = require("./fileInspector");
const assetService = require("./assetService");

/**
 * Validates layers against the product's print areas and computes print-resolution warnings.
 * Throws when a layer would print below the product's hard DPI threshold.
 */
async function validateCanvas(product, canvas, auth) {
  const areas = await PrintArea.findAll({ where: { product_id: product.id } });
  const byCode = new Map(areas.map((a) => [a.code, a]));
  const warnings = [];
  const assetIds = new Set();
  let usedAreas = 0;
  let textLines = 0;

  for (const [code, area] of Object.entries(canvas.areas || {})) {
    const def = byCode.get(code);
    if (!def) throw ApiError.unprocessable(`Unknown print area "${code}"`, "PRINT_AREA_INVALID");
    const layers = area.layers || [];
    if (layers.length) usedAreas += 1;
    for (const layer of layers) {
      if (layer.type === "image") assetIds.add(layer.assetId);
      if (layer.type === "text") {
        textLines += 1;
        if ((layer.text || "").length > def.max_text_chars) {
          throw ApiError.unprocessable(`Text in ${def.name} is limited to ${def.max_text_chars} characters`, "TEXT_TOO_LONG");
        }
      }
    }
  }
  if (textLines > product.max_text_lines * Math.max(1, usedAreas)) {
    throw ApiError.unprocessable(`Up to ${product.max_text_lines} text lines are allowed per print area`, "TOO_MANY_TEXT_LINES");
  }

  const assets = await assetService.assertUsable(auth, [...assetIds]);
  const assetById = new Map(assets.map((a) => [a.id, a]));
  for (const [code, area] of Object.entries(canvas.areas || {})) {
    const def = byCode.get(code);
    for (const layer of area.layers || []) {
      if (layer.type !== "image") continue;
      const asset = assetById.get(layer.assetId);
      if (!asset || !asset.width_px) continue; // vector artwork has no resolution limit
      // Layer width/height are fractions (0..1) of the print area box.
      const printW = Number(def.width_mm) * Math.min(1, Math.max(0.01, Number(layer.width) || 1));
      const printH = Number(def.height_mm) * Math.min(1, Math.max(0.01, Number(layer.height) || 1));
      const dpi = inspector.effectiveDpi(asset.width_px, asset.height_px, printW, printH);
      if (dpi !== null && dpi < product.block_below_dpi) {
        throw ApiError.unprocessable(
          `"${asset.original_name}" is too low resolution for ${def.name} (${dpi} DPI). Upload a larger image or make it smaller.`,
          "RESOLUTION_TOO_LOW",
          { dpi, area: code, assetId: asset.id }
        );
      }
      if (dpi !== null && dpi < product.min_dpi) {
        warnings.push({ type: "low_resolution", area: code, assetId: asset.id, dpi, message: `"${asset.original_name}" will print at about ${dpi} DPI in ${def.name}. ${product.min_dpi} DPI or more is recommended.` });
      }
    }
  }
  return { warnings, assetIds: [...assetIds], usedAreas };
}

async function loadOwned(auth, id, { transaction } = {}) {
  const design = await Design.findByPk(id, { transaction });
  const canUse =
    design && (design.user_id === auth.user.id || (design.company_id && design.company_id === auth.companyId && design.is_brand_template));
  if (!canUse) throw ApiError.notFound("Design not found");
  return design;
}

async function saveVersion(auth, { designId, productId, variantId, methodId, name, canvas, previewAssetId, brandTemplate = false }) {
  return sequelize.transaction(async (transaction) => {
    let design;
    if (designId) {
      design = await loadOwned(auth, designId, { transaction });
      if (design.user_id !== auth.user.id) throw ApiError.forbidden("Copy this brand template to edit it");
    }
    const product = await Product.findByPk(design ? design.product_id : productId, { transaction });
    if (!product || !product.is_customisable) throw ApiError.unprocessable("This product cannot be customised", "NOT_CUSTOMISABLE");
    if (variantId) {
      const variant = await ProductVariant.findOne({ where: { id: variantId, product_id: product.id }, transaction });
      if (!variant) throw ApiError.unprocessable("Choose an option for this product", "VARIANT_INVALID");
    }
    if (previewAssetId) await assetService.assertUsable(auth, [previewAssetId]);
    const { warnings, assetIds } = await validateCanvas(product, canvas, auth);

    if (!design) {
      if (brandTemplate && !auth.permissions.has("company.brand.manage")) throw ApiError.forbidden("Only company admins can publish brand templates");
      design = await Design.create(
        {
          user_id: auth.user.id,
          company_id: auth.companyId || null,
          product_id: product.id,
          variant_id: variantId || null,
          name: name || `${product.name} design`,
          is_brand_template: Boolean(brandTemplate),
        },
        { transaction }
      );
    } else if (name) {
      await design.update({ name, variant_id: variantId || design.variant_id }, { transaction });
    }
    const last = await DesignVersion.max("version_no", { where: { design_id: design.id }, transaction });
    const version = await DesignVersion.create(
      {
        design_id: design.id,
        version_no: (last || 0) + 1,
        canvas,
        asset_ids: assetIds,
        preview_asset_id: previewAssetId || null,
        method_id: methodId || null,
        variant_id: variantId || design.variant_id,
        warnings,
        created_by: auth.user.id,
      },
      { transaction }
    );
    await design.update({ current_version_id: version.id }, { transaction });
    return { design: await presentDesign(design, { transaction }), version: presentVersion(version) };
  });
}

function presentVersion(v) {
  return {
    id: v.id,
    designId: v.design_id,
    versionNo: v.version_no,
    canvas: v.canvas,
    assetIds: v.asset_ids,
    previewUrl: v.preview_asset_id ? `/api/v1/assets/${v.preview_asset_id}` : null,
    methodId: v.method_id,
    variantId: v.variant_id,
    warnings: v.warnings,
    printAreaCount: Object.values(v.canvas?.areas || {}).filter((a) => (a.layers || []).length).length,
    createdAt: v.created_at,
  };
}

async function presentDesign(design, { transaction } = {}) {
  const [product, current] = await Promise.all([
    Product.findByPk(design.product_id, { attributes: ["id", "name", "slug", "images"], transaction }),
    design.current_version_id ? DesignVersion.findByPk(design.current_version_id, { transaction }) : null,
  ]);
  return {
    id: design.id,
    name: design.name,
    isBrandTemplate: design.is_brand_template,
    product: product ? { id: product.id, name: product.name, slug: product.slug, image: (product.images || [])[0] } : null,
    variantId: design.variant_id,
    currentVersion: current ? presentVersion(current) : null,
    updatedAt: design.updated_at,
  };
}

async function list(auth, { includeBrand = true } = {}) {
  const where = includeBrand && auth.companyId
    ? { [Op.or]: [{ user_id: auth.user.id }, { company_id: auth.companyId, is_brand_template: true }] }
    : { user_id: auth.user.id };
  const designs = await Design.findAll({ where, order: [["updated_at", "DESC"]], limit: 100 });
  return Promise.all(designs.map((d) => presentDesign(d)));
}

async function get(auth, id) {
  const design = await loadOwned(auth, id);
  const versions = await DesignVersion.findAll({ where: { design_id: design.id }, order: [["version_no", "DESC"]] });
  return { ...(await presentDesign(design)), versions: versions.map(presentVersion) };
}

async function remove(auth, id) {
  const design = await loadOwned(auth, id);
  if (design.user_id !== auth.user.id) throw ApiError.forbidden();
  await design.destroy();
}

// Loads a version the user may attach to a cart line or quote.
async function usableVersion(auth, versionId, productId, { transaction } = {}) {
  const version = await DesignVersion.findByPk(versionId, { include: [{ model: Design, as: "design" }], transaction });
  if (!version || !version.design) throw ApiError.unprocessable("Design not found", "DESIGN_NOT_FOUND");
  const d = version.design;
  const allowed = d.user_id === auth.user.id || (d.company_id && d.company_id === auth.companyId && d.is_brand_template);
  if (!allowed) throw ApiError.unprocessable("Design not found", "DESIGN_NOT_FOUND");
  if (productId && d.product_id !== productId) throw ApiError.unprocessable("This design was made for a different product", "DESIGN_PRODUCT_MISMATCH");
  return version;
}

async function assetsForVersion(version) {
  if (!version.asset_ids?.length) return [];
  return ArtworkAsset.findAll({ where: { id: version.asset_ids } });
}

module.exports = { saveVersion, list, get, remove, usableVersion, assetsForVersion, presentVersion, validateCanvas };
