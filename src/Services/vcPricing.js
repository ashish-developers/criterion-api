// Visiting card pricing. Pure functions (no database) so the rules are unit-testable;
// vcOrderService loads slabs, options and settings and calls these. All money is integer paise,
// prices exclude GST, and the server is the only place totals are calculated.
//
//   unit     = slab price for the order's total cards + chosen print options + double-sided surcharge
//   subtotal = unit × total cards
//   shipping = base + per extra box (box_size cards), free above a subtotal when configured
//   GST      = on subtotal (cards) and on shipping, split CGST/SGST intra-state or IGST inter-state
const engine = require("./pricingEngine");

/** The slab whose range contains the quantity, or null when no slab prices it. */
function slabFor(slabs, quantity) {
  return (
    [...slabs]
      .sort((a, b) => a.min_qty - b.min_qty)
      .find((s) => quantity >= s.min_qty && (s.max_qty === null || s.max_qty === undefined || quantity <= s.max_qty)) || null
  );
}

/**
 * Checks a full slab table: sorted by quantity, no overlaps or gaps, only the last one open-ended,
 * and the first one starting at or below the order minimum. Returns a list of problems.
 */
function slabProblems(slabs, minOrderQty) {
  const problems = [];
  const sorted = [...slabs].sort((a, b) => a.min_qty - b.min_qty);
  if (!sorted.length) return ["Add at least one price slab"];
  if (sorted[0].min_qty > minOrderQty) problems.push(`The first slab must start at ${minOrderQty} cards or fewer (the minimum order)`);
  sorted.forEach((slab, i) => {
    const open = slab.max_qty === null || slab.max_qty === undefined;
    if (!open && slab.max_qty < slab.min_qty) problems.push(`Slab ${i + 1}: the maximum is below the minimum`);
    if (open && i !== sorted.length - 1) problems.push(`Slab ${i + 1}: only the last slab can have no maximum`);
    const next = sorted[i + 1];
    if (next && !open && next.min_qty !== slab.max_qty + 1) {
      problems.push(next.min_qty <= slab.max_qty ? `Slabs ${i + 1} and ${i + 2} overlap` : `Quantities ${slab.max_qty + 1} to ${next.min_qty - 1} have no price`);
    }
  });
  return problems;
}

function shippingCharge(totalQuantity, subtotalPaise, shipping) {
  if (shipping.free_above_paise > 0 && subtotalPaise >= shipping.free_above_paise) return 0;
  const boxes = Math.max(1, Math.ceil(totalQuantity / Math.max(1, shipping.box_size)));
  return shipping.base_paise + (boxes - 1) * shipping.per_box_paise;
}

/**
 * @param {object} input
 * @param {number[]} input.quantities  cards printed per person (one entry for an individual order)
 * @param {boolean} input.doubleSided
 * @param {{min_qty:number,max_qty:number|null,unit_price_paise:number}[]} input.slabs
 * @param {{group_code:string,code:string,name:string,price_per_card_paise:number}[]} input.options  chosen options
 * @param {object} input.settings  the visiting_cards setting
 * @param {boolean} input.interstate
 */
function quote({ quantities, doubleSided, slabs, options, settings, interstate }) {
  const totalQuantity = quantities.reduce((s, q) => s + q, 0);
  const slab = slabFor(slabs, totalQuantity);
  if (!slab) return { priced: false, totalQuantity, reason: "No price is set for this quantity. Contact us for a quote." };

  const optionsPerCard = options.reduce((s, o) => s + o.price_per_card_paise, 0);
  const sidesPerCard = doubleSided ? settings.double_sided_per_card_paise : 0;
  const unitPaise = slab.unit_price_paise + optionsPerCard + sidesPerCard;
  const subtotalPaise = unitPaise * totalQuantity;
  const shippingPaise = shippingCharge(totalQuantity, subtotalPaise, settings.shipping);

  const cardTax = engine.gst(subtotalPaise, Number(settings.gst_rate), interstate);
  const shipTax = engine.gst(shippingPaise, Number(settings.shipping.gst_rate), interstate);
  const tax = {
    cgst: cardTax.cgst + shipTax.cgst,
    sgst: cardTax.sgst + shipTax.sgst,
    igst: cardTax.igst + shipTax.igst,
    total: cardTax.total + shipTax.total,
  };
  return {
    priced: true,
    totalQuantity,
    cardCount: quantities.length,
    slab: { minQty: slab.min_qty, maxQty: slab.max_qty, unitPricePaise: slab.unit_price_paise, label: slab.label || null },
    options: options.map((o) => ({ group: o.group_code, code: o.code, name: o.name, pricePerCardPaise: o.price_per_card_paise })),
    optionsPerCardPaise: optionsPerCard,
    doubleSidedPerCardPaise: sidesPerCard,
    unitPricePaise: unitPaise,
    subtotalPaise,
    shippingPaise,
    taxablePaise: subtotalPaise + shippingPaise,
    gstRate: Number(settings.gst_rate),
    shippingGstRate: Number(settings.shipping.gst_rate),
    cardTax,
    shippingTax: shipTax,
    cgstPaise: tax.cgst,
    sgstPaise: tax.sgst,
    igstPaise: tax.igst,
    taxPaise: tax.total,
    totalPaise: subtotalPaise + shippingPaise + tax.total,
    interstate,
  };
}

module.exports = { slabFor, slabProblems, shippingCharge, quote };
