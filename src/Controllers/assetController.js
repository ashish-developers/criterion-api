const assetService = require("../Services/assetService");
const designService = require("../Services/designService");
const { ok, created } = require("../Utils/http");

module.exports = {
  upload: async (req, res) => {
    const q = req.validatedQuery;
    const asset = await assetService.upload(req.auth, req.file, { kind: q.kind, companyAsset: q.companyAsset === "true", brandKitId: q.brandKitId });
    return created(res, asset, "File uploaded");
  },
  mine: async (req, res) => ok(res, await assetService.listMine(req.auth, { kind: req.query.kind, companyOnly: req.query.company === "true" && Boolean(req.auth.companyId) })),
  download: async (req, res) => {
    const { asset, buffer } = await assetService.getForDownload(req.auth, req.params.id);
    res.setHeader("Content-Type", asset.mime_type);
    res.setHeader("Content-Length", buffer.length);
    res.setHeader("X-Content-Type-Options", "nosniff");
    res.setHeader("Cache-Control", asset.is_public ? "public, max-age=86400" : "private, max-age=300");
    // User-supplied SVG/PDF must never run script in our origin.
    res.setHeader("Content-Security-Policy", "default-src 'none'; img-src 'self' data:; style-src 'unsafe-inline'; sandbox");
    const disposition = req.query.download === "1" ? "attachment" : "inline";
    res.setHeader("Content-Disposition", `${disposition}; filename="${encodeURIComponent(asset.original_name)}"`);
    return res.end(buffer);
  },
  // Designs
  designs: async (req, res) => ok(res, await designService.list(req.auth)),
  design: async (req, res) => ok(res, await designService.get(req.auth, req.params.id)),
  saveDesign: async (req, res) => created(res, await designService.saveVersion(req.auth, req.body), "Design saved"),
  deleteDesign: async (req, res) => {
    await designService.remove(req.auth, req.params.id);
    return ok(res, null, "Design deleted");
  },
};
