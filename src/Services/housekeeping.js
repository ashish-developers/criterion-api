// Scheduled business rules. Implementations live in their domain services.
function registerAll(register) {
  const HOUR = 60 * 60 * 1000;
  const quoteService = require("./quoteService");
  const proofService = require("./proofService");
  const orderService = require("./orderService");
  const productionService = require("./productionService");

  register("expire-quotes", () => quoteService.expireDue(), HOUR);
  register("proof-reminders", () => proofService.sendReminders(), HOUR);
  register("close-delivered-lines", () => orderService.closeDeliveredLines(), 6 * HOUR);
  register("escalate-at-risk-jobs", () => productionService.escalateAtRisk(), 3 * HOUR);
}

module.exports = { registerAll };
