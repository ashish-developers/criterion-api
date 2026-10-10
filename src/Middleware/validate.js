const ApiError = require("../Utils/ApiError");

// validate({ body: schema, query: schema, params: schema }) using zod schemas.
// Parsed (coerced, stripped) values replace the originals; Express 5 makes req.query
// a getter, so parsed query values are exposed as req.validatedQuery.
function validate(schemas) {
  return (req, res, next) => {
    const details = {};
    for (const part of ["params", "query", "body"]) {
      if (!schemas[part]) continue;
      const result = schemas[part].safeParse(req[part] ?? {});
      if (!result.success) {
        for (const issue of result.error.issues) {
          const field = issue.path.join(".") || part;
          if (!details[field]) details[field] = issue.message;
        }
      } else if (part === "query") {
        req.validatedQuery = result.data;
      } else {
        req[part] = result.data;
      }
    }
    if (Object.keys(details).length) {
      return next(ApiError.unprocessable("Please correct the highlighted fields", "VALIDATION_FAILED", details));
    }
    next();
  };
}

module.exports = { validate };
