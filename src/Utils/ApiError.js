// Errors thrown from services/controllers. The error handler turns them into
// the standard response shape: { status: false, message, code, details }.
class ApiError extends Error {
  constructor(statusCode, message, code = "ERROR", details) {
    super(message);
    this.statusCode = statusCode;
    this.code = code;
    this.details = details;
  }

  static badRequest(message, details, code = "BAD_REQUEST") {
    return new ApiError(400, message, code, details);
  }
  static unauthorized(message = "Authentication required", code = "UNAUTHORIZED") {
    return new ApiError(401, message, code);
  }
  static forbidden(message = "You do not have permission to perform this action", code = "FORBIDDEN") {
    return new ApiError(403, message, code);
  }
  static notFound(message = "Resource not found", code = "NOT_FOUND") {
    return new ApiError(404, message, code);
  }
  static conflict(message, code = "CONFLICT", details) {
    return new ApiError(409, message, code, details);
  }
  static unprocessable(message, code = "UNPROCESSABLE", details) {
    return new ApiError(422, message, code, details);
  }
  static tooMany(message = "Too many requests, please try again later", retryAfterSeconds) {
    const error = new ApiError(429, message, "RATE_LIMITED", retryAfterSeconds ? { retryAfterSeconds } : undefined);
    error.retryAfter = retryAfterSeconds;
    return error;
  }
}

module.exports = ApiError;
