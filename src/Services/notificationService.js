// Transactional notifications (Section 6.10): stored in-app and sent by email.
// SMS / WhatsApp channels plug in here once DLT templates are registered.
const { Notification, User } = require("../Models");
const mailService = require("./mailService");
const { config } = require("../Config/env");

async function notify(userId, { type, title, body, link, email = true }, { transaction } = {}) {
  if (!userId) return null;
  const notification = await Notification.create(
    { user_id: userId, type, title, body, link, channels: email ? ["in_app", "email"] : ["in_app"] },
    { transaction }
  );
  if (email) {
    // Send after the surrounding transaction commits so we never email about rolled-back work.
    const deliver = async () => {
      const user = await User.findByPk(userId);
      if (!user) return;
      const url = link ? `${config.webAppUrl}${link}` : config.webAppUrl;
      const result = await mailService.send({
        to: user.email,
        subject: title,
        text: `${body || title}\n\n${url}`,
        html: `<p>${escapeHtml(body || title)}</p><p><a href="${url}">${url}</a></p>`,
      });
      await Notification.update({ email_status: result.delivered ? "sent" : result.driver || "failed" }, { where: { id: notification.id } });
    };
    if (transaction) transaction.afterCommit(() => deliver().catch(() => {}));
    else deliver().catch(() => {});
  }
  return notification;
}

function escapeHtml(text) {
  return String(text).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
}

module.exports = { notify };
