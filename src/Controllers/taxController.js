// Tax master endpoints (GST rates, HSN/SAC codes).
const taxService = require("../Services/taxService");
const auditService = require("../Services/auditService");
const { ok, created, pageParams, pageMeta } = require("../Utils/http");

const rates = async (req, res) => ok(res, await taxService.listRates());
const createRate = async (req, res) => {
  const rate = await taxService.saveRate(req.body);
  await auditService.record(req, "tax.rate_create", "tax_rate", String(rate.id), { after: req.body });
  return created(res, rate, "GST rate added");
};
const updateRate = async (req, res) => {
  const rate = await taxService.saveRate(req.body, req.params.id);
  await auditService.record(req, "tax.rate_update", "tax_rate", String(rate.id), { after: req.body });
  return ok(res, rate, rate.productsUpdated ? `GST rate updated; ${rate.productsUpdated} product(s) now use the new rate` : "GST rate updated");
};
const rateActive = async (req, res) => {
  const rate = await taxService.setRateActive(req.params.id, req.body.active);
  await auditService.record(req, req.body.active ? "tax.rate_activate" : "tax.rate_deactivate", "tax_rate", String(rate.id));
  return ok(res, rate, req.body.active ? "GST rate activated" : "GST rate deactivated");
};

const hsnList = async (req, res) => {
  const paging = pageParams(req.validatedQuery);
  const result = await taxService.listHsn({ ...req.validatedQuery, ...paging });
  return ok(res, result.items, "OK", pageMeta(paging, result.total));
};
const createHsn = async (req, res) => {
  const hsn = await taxService.saveHsn(req.body);
  await auditService.record(req, "tax.hsn_create", "hsn_code", String(hsn.id), { after: req.body });
  return created(res, hsn, hsn.productsUpdated ? `Code added; ${hsn.productsUpdated} product(s) moved to its rate` : "Code added");
};
const updateHsn = async (req, res) => {
  const hsn = await taxService.saveHsn(req.body, req.params.id);
  await auditService.record(req, "tax.hsn_update", "hsn_code", String(hsn.id), { after: req.body });
  return ok(res, hsn, hsn.productsUpdated ? `Code updated; ${hsn.productsUpdated} product(s) moved to its rate` : "Code updated");
};
const hsnActive = async (req, res) => {
  const hsn = await taxService.setHsnActive(req.params.id, req.body.active);
  await auditService.record(req, req.body.active ? "tax.hsn_activate" : "tax.hsn_deactivate", "hsn_code", String(hsn.id));
  return ok(res, hsn, req.body.active ? "Code activated" : "Code deactivated");
};

const options = async (req, res) => ok(res, await taxService.options());

module.exports = { rates, createRate, updateRate, rateActive, hsnList, createHsn, updateHsn, hsnActive, options };
