// Rule-based serviceability, shipping charge and delivery-date estimate by PIN code.
// Stands in for a shipping aggregator (Shiprocket/Delhivery) until one is integrated:
// replace `zoneFor` / `quote` with the aggregator's rate API without changing callers.
const settingsService = require("./settingsService");

function validPincode(pincode) {
  return /^[1-9][0-9]{5}$/.test(String(pincode || ""));
}

function zoneFor(origin, destination, cfg) {
  const dest = String(destination);
  if ((cfg.unserviceable_prefixes || []).some((p) => dest.startsWith(p))) return null;
  if ((cfg.remote_prefixes || []).some((p) => dest.startsWith(p))) return "remote";
  if (dest.slice(0, 3) === String(origin).slice(0, 3)) return "local";
  if (dest[0] === String(origin)[0]) return "regional";
  return "national";
}

// Adds working days, skipping Sundays.
function addWorkingDays(start, days) {
  const date = new Date(start);
  let added = 0;
  while (added < days) {
    date.setDate(date.getDate() + 1);
    if (date.getDay() !== 0) added += 1;
  }
  return date;
}

function toDateOnly(date) {
  return date.toISOString().slice(0, 10);
}

/**
 * @param {{pincode:string, weightGrams:number, subtotalPaise:number, productionDays:number}} input
 */
async function quote({ pincode, weightGrams = 500, subtotalPaise = 0, productionDays = 5, from = new Date() }) {
  const cfg = await settingsService.get("shipping");
  if (!validPincode(pincode)) return { serviceable: false, reason: "Enter a valid 6-digit PIN code" };
  const zone = zoneFor(cfg.origin_pincode, pincode, cfg);
  if (!zone) return { serviceable: false, reason: "We do not deliver to this PIN code yet" };

  const transitDays = cfg.transit_days[zone];
  const slabs = Math.max(1, Math.ceil(weightGrams / 500));
  let charge = cfg.base_paise + (slabs - 1) * cfg.per_500g_paise;
  if (zone === "remote") charge = Math.round(charge * 1.5);
  const free = cfg.free_above_paise > 0 && subtotalPaise >= cfg.free_above_paise;

  const dispatchBy = addWorkingDays(from, productionDays);
  const deliverBy = addWorkingDays(dispatchBy, transitDays);
  return {
    serviceable: true,
    zone,
    transitDays,
    productionDays,
    chargePaise: free ? 0 : charge,
    freeShipping: free,
    gstRate: cfg.gst_rate,
    estimatedDispatch: toDateOnly(dispatchBy),
    estimatedDelivery: toDateOnly(deliverBy),
    isEstimate: zone === "remote",
  };
}

module.exports = { quote, validPincode, addWorkingDays, toDateOnly, zoneFor };
