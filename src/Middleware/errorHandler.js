const ApiError = require("../Utils/ApiError");
const { config } = require("../Config/env");

function notFound(req, res, next) {
  next(ApiError.notFound(`Route ${req.method} ${req.originalUrl} not found`, "ROUTE_NOT_FOUND"));
}

// Central error handler: one response shape, no stack traces or SQL leaked to clients.
// eslint-disable-next-line no-unused-vars
function errorHandler(error, req, res, next) {
  let status = error.statusCode || error.status || 500;
  let body = { status: false, message: error.message, code: error.code || "ERROR" };

  if (error instanceof ApiError) {
    if (error.details) body.details = error.details;
  } else if (error.name === "SequelizeUniqueConstraintError") {
    status = 409;
    body = { status: false, message: "A record with these details already exists", code: "DUPLICATE" };
  } else if (error.name === "SequelizeForeignKeyConstraintError") {
    status = 422;
    body = { status: false, message: "A referenced record does not exist", code: "INVALID_REFERENCE" };
  } else if (error.name === "SequelizeValidationError" || error.name === "SequelizeDatabaseError") {
    status = error.name === "SequelizeDatabaseError" && /locked/.test(error.message) ? 409 : 400;
    body = { status: false, message: status === 409 ? "This record is locked and cannot be changed" : "Invalid data", code: "DATABASE_ERROR" };
    if (!config.isProduction) body.debug = error.message;
  } else if (error.type === "entity.parse.failed") {
    status = 400;
    body = { status: false, message: "Malformed JSON body", code: "BAD_JSON" };
  } else if (error.name === "MulterError") {
    status = error.code === "LIMIT_FILE_SIZE" ? 413 : 400;
    body = {
      status: false,
      message: error.code === "LIMIT_FILE_SIZE" ? `File is larger than the ${config.storage.maxUploadMb} MB limit` : error.message,
      code: error.code,
    };
  } else if (status >= 500) {
    console.error(`[error] ${req.method} ${req.originalUrl}:`, error);
    body = { status: false, message: "Something went wrong. Please try again.", code: "INTERNAL_ERROR" };
  }

  res.status(status).json(body);
}

module.exports = { notFound, errorHandler };
