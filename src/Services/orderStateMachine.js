// Order-line state model (Section 7.1). Each order line holds its own state so a kit
// or mixed cart can ship in parts; the order status is derived from its lines.

const TRANSITIONS = {
  placed: ["payment_pending", "artwork_pending", "proof_approved", "cancelled", "on_hold"],
  payment_pending: ["artwork_pending", "proof_approved", "cancelled", "on_hold"],
  artwork_pending: ["proof_sent", "cancelled", "on_hold"],
  proof_sent: ["proof_approved", "artwork_pending", "cancelled", "on_hold"],
  proof_approved: ["assigned", "cancelled", "on_hold"],
  assigned: ["in_production", "proof_approved", "cancelled", "on_hold"],
  in_production: ["quality_check", "on_hold"],
  quality_check: ["packed", "qc_failed"],
  qc_failed: ["in_production", "assigned", "refunded"],
  packed: ["dispatched", "on_hold"],
  dispatched: ["delivered", "rto"],
  delivered: ["closed"],
  rto: ["dispatched", "refunded"],
  on_hold: [], // resumes to previous_state (validated separately)
  cancelled: ["refunded"],
  closed: [],
  refunded: [],
};

// Customer self-service cancellation rules (Section 7.6).
const CANCELLATION = {
  free: ["placed", "payment_pending", "artwork_pending", "proof_sent"],
  withCharges: ["proof_approved", "assigned"],
};

const TERMINAL = ["closed", "cancelled", "refunded"];

function canTransition(from, to, previousState) {
  if (from === to) return false;
  if (from === "on_hold") return to === previousState || to === "cancelled";
  return (TRANSITIONS[from] || []).includes(to);
}

function assertTransition(from, to, previousState) {
  if (!canTransition(from, to, previousState)) {
    const error = new Error(`Order line cannot move from "${from}" to "${to}"`);
    error.statusCode = 409;
    error.code = "INVALID_STATE_TRANSITION";
    throw error;
  }
}

function cancellationPolicy(state) {
  if (CANCELLATION.free.includes(state)) return { allowed: true, charges: false };
  if (CANCELLATION.withCharges.includes(state)) return { allowed: true, charges: true };
  return { allowed: false, charges: false };
}

// Derive the order-level status from line states.
function deriveOrderStatus(states, { approvalPending = false, paymentPending = false } = {}) {
  const live = states.filter((s) => !["cancelled", "refunded"].includes(s));
  if (!live.length) return states.every((s) => s === "refunded") ? "refunded" : "cancelled";
  if (approvalPending) return "awaiting_approval";
  if (live.every((s) => s === "closed")) return "completed";
  if (live.every((s) => ["delivered", "closed"].includes(s))) return "delivered";
  if (live.every((s) => ["dispatched", "delivered", "closed"].includes(s))) return "shipped";
  if (live.some((s) => ["dispatched", "delivered", "closed"].includes(s))) return "partially_shipped";
  if (paymentPending || live.every((s) => ["placed", "payment_pending"].includes(s))) return "payment_pending";
  if (live.some((s) => ["assigned", "in_production", "quality_check", "qc_failed", "packed"].includes(s))) return "in_progress";
  return "confirmed";
}

module.exports = { TRANSITIONS, TERMINAL, canTransition, assertTransition, cancellationPolicy, deriveOrderStatus };
