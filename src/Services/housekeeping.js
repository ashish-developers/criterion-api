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
  // Queued transactional email (invitations); retries failed sends with backoff.
  register("email-outbox", () => require("./emailOutboxService").processDue(), 30 * 1000);
  // Scheduled blog posts go live (public pages also show due posts before this runs).
  register("publish-scheduled-blog-posts", () => require("./blogService").publishDue(), 60 * 1000);
}

module.exports = { registerAll };
