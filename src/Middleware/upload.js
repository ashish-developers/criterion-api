const multer = require("multer");
const { config } = require("../Config/env");

// Files are held in memory, inspected by content, then written to storage by assetService.
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: config.storage.maxUploadMb * 1024 * 1024, files: 10 },
});

module.exports = { upload };
