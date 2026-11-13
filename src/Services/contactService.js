// Contact and enquiry email service.
// Renders email templates and delivers messages to CONTACT_US (configured in .env)
// as well as confirmation emails to visitors.
const { config } = require("../Config/env");
const mailService = require("./mailService");

const esc = (text) =>
  String(text ?? "")
    .replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);

function renderAdminContactHtml({ name, email, phone, subject, message, type = "General Contact" }) {
  const brand = config.brandName;
  return `
<!DOCTYPE html>
<html>
<head>
  <meta charset="utf-8">
  <title>New ${esc(type)} Message</title>
  <style>
    body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif; background-color: #f8fafc; color: #1e293b; margin: 0; padding: 24px; }
    .card { background: #ffffff; border-radius: 8px; border: 1px solid #e2e8f0; max-width: 600px; margin: 0 auto; overflow: hidden; box-shadow: 0 4px 6px -1px rgba(0,0,0,0.05); }
    .header { background: #E4572E; color: #ffffff; padding: 20px 24px; }
    .header h1 { margin: 0; font-size: 20px; font-weight: 600; }
    .header p { margin: 4px 0 0; font-size: 13px; color: #ffedd5; }
    .body { padding: 24px; }
    .field { margin-bottom: 16px; }
    .field-label { font-size: 12px; text-transform: uppercase; letter-spacing: 0.05em; color: #64748b; font-weight: 600; margin-bottom: 4px; }
    .field-value { font-size: 15px; color: #0f172a; }
    .message-box { background: #f8fafc; border-left: 4px solid #E4572E; padding: 14px 18px; border-radius: 4px; font-size: 14px; line-height: 1.6; white-space: pre-wrap; margin-top: 8px; color: #334155; }
    .footer { background: #f8fafc; border-top: 1px solid #e2e8f0; padding: 16px 24px; font-size: 12px; color: #64748b; text-align: center; }
  </style>
</head>
<body>
  <div class="card">
    <div class="header">
      <h1>New ${esc(type)} Message</h1>
      <p>Submitted from ${esc(brand)} - Contact Is </p>
    </div>
    <div class="body">
      <div class="field">
        <div class="field-label">From</div>
        <div class="field-value"><strong>${esc(name)}</strong> &lt;<a href="mailto:${esc(email)}">${esc(email)}</a>&gt;</div>
      </div>
      ${
        phone
          ? `
      <div class="field">
        <div class="field-label">Phone</div>
        <div class="field-value"><a href="tel:${esc(phone)}">${esc(phone)}</a></div>
      </div>`
          : ""
      }
      <div class="field">
        <div class="field-label">Subject</div>
        <div class="field-value"><strong>${esc(subject)}</strong></div>
      </div>
      <div class="field">
        <div class="field-label">Message</div>
        <div class="message-box">${esc(message)}</div>
      </div>
    </div>
    <div class="footer">
      Reply directly to this email to respond to ${esc(name)} (&lt;${esc(email)}&gt;).
    </div>
  </div>
</body>
</html>
  `.trim();
}

function renderAdminEnquiryHtml({ name, company, email, phone, category, quantity, city, notes }) {
  const brand = config.brandName;
  return `
<!DOCTYPE html>
<html>
<head>
  <meta charset="utf-8">
  <title>New Corporate Quote Enquiry</title>
  <style>
    body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif; background-color: #f8fafc; color: #1e293b; margin: 0; padding: 24px; }
    .card { background: #ffffff; border-radius: 8px; border: 1px solid #e2e8f0; max-width: 600px; margin: 0 auto; overflow: hidden; box-shadow: 0 4px 6px -1px rgba(0,0,0,0.05); }
    .header { background: #1E293B; border-bottom: 4px solid #E4572E; color: #ffffff; padding: 20px 24px; }
    .header h1 { margin: 0; font-size: 20px; font-weight: 600; }
    .header p { margin: 4px 0 0; font-size: 13px; color: #cbd5e1; }
    .body { padding: 24px; }
    .grid { width: 100%; border-collapse: collapse; margin-bottom: 16px; }
    .grid td { padding: 9px 12px; border-bottom: 1px solid #f1f5f9; vertical-align: top; }
    .grid-label { font-size: 13px; color: #64748b; font-weight: 500; width: 35%; }
    .grid-value { font-size: 14px; color: #0f172a; font-weight: 600; }
    .notes-box { background: #f8fafc; border: 1px solid #e2e8f0; border-radius: 6px; padding: 14px 18px; font-size: 14px; line-height: 1.6; white-space: pre-wrap; margin-top: 8px; color: #334155; }
    .footer { background: #f8fafc; border-top: 1px solid #e2e8f0; padding: 16px 24px; font-size: 12px; color: #64748b; text-align: center; }
  </style>
</head>
<body>
  <div class="card">
    <div class="header">
      <h1>New Corporate Quote Enquiry</h1>
      <p>Submitted via ${esc(brand)} Homepage Quote Form</p>
    </div>
    <div class="body">
      <table class="grid">
        <tr>
          <td class="grid-label">Contact Person</td>
          <td class="grid-value">${esc(name)}</td>
        </tr>
        <tr>
          <td class="grid-label">Company Name</td>
          <td class="grid-value">${esc(company)}</td>
        </tr>
        <tr>
          <td class="grid-label">Work Email</td>
          <td class="grid-value"><a href="mailto:${esc(email)}">${esc(email)}</a></td>
        </tr>
        <tr>
          <td class="grid-label">Phone Number</td>
          <td class="grid-value"><a href="tel:${esc(phone)}">${esc(phone)}</a></td>
        </tr>
        ${
          category
            ? `<tr>
          <td class="grid-label">Product Category</td>
          <td class="grid-value">${esc(category)}</td>
        </tr>`
            : ""
        }
        ${
          quantity
            ? `<tr>
          <td class="grid-label">Estimated Quantity</td>
          <td class="grid-value">${esc(quantity)}</td>
        </tr>`
            : ""
        }
        ${
          city
            ? `<tr>
          <td class="grid-label">Delivery City</td>
          <td class="grid-value">${esc(city)}</td>
        </tr>`
            : ""
        }
      </table>

      ${
        notes
          ? `
      <div>
        <div style="font-size: 12px; text-transform: uppercase; letter-spacing: 0.05em; color: #64748b; font-weight: 600; margin-bottom: 4px;">Additional Requirements</div>
        <div class="notes-box">${esc(notes)}</div>
      </div>`
          : ""
      }
    </div>
    <div class="footer">
      Reply directly to this email to follow up with ${esc(name)} &lt;${esc(email)}&gt;.
    </div>
  </div>
</body>
</html>
  `.trim();
}

function renderUserAckHtml({ name, isEnquiry = false }) {
  const brand = config.brandName;
  return `
<!DOCTYPE html>
<html>
<head>
  <meta charset="utf-8">
  <title>Thank You - ${esc(brand)}</title>
  <style>
    body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif; background-color: #f8fafc; color: #1e293b; margin: 0; padding: 24px; }
    .card { background: #ffffff; border-radius: 8px; border: 1px solid #e2e8f0; max-width: 600px; margin: 0 auto; overflow: hidden; box-shadow: 0 4px 6px -1px rgba(0,0,0,0.05); }
    .header { background: #E4572E; color: #ffffff; padding: 24px; text-align: center; }
    .header h1 { margin: 0; font-size: 22px; font-weight: 600; }
    .body { padding: 32px 24px; line-height: 1.6; font-size: 15px; color: #334155; }
    .btn { display: inline-block; background-color: #E4572E; color: #ffffff !important; padding: 12px 24px; border-radius: 6px; text-decoration: none; font-weight: 600; margin-top: 16px; }
    .footer { background: #f8fafc; border-top: 1px solid #e2e8f0; padding: 20px 24px; font-size: 12px; color: #64748b; text-align: center; }
  </style>
</head>
<body>
  <div class="card">
    <div class="header">
      <h1>Thank You for Contacting ${esc(brand)}</h1>
    </div>
    <div class="body">
      <p>Hello ${esc(name)},</p>
      <p>We have successfully received your ${isEnquiry ? "corporate gifting quotation request" : "message"}. Our corporate sales and customer support team is reviewing your requirements and will get back to you shortly (usually within 4 business hours).</p>
      <p>If you have additional details or artwork files to share, you can reply directly to this email or reach us at <a href="mailto:${esc(config.contactUsEmail)}">${esc(config.contactUsEmail)}</a>.</p>
      <p style="margin-top: 24px; text-align: center;">
        <a href="${esc(config.webAppUrl)}" class="btn">Explore ${esc(brand)}</a>
      </p>
    </div>
    <div class="footer">
      &copy; ${new Date().getFullYear()} ${esc(brand)}. All rights reserved.
    </div>
  </div>
</body>
</html>
  `.trim();
}

async function sendContactMessage(data) {
  const { name, email, phone, subject, message } = data;
  const adminSubject = `[Contact Us] ${subject}`;
  const adminText = [
    `New contact form message on ${config.brandName}`,
    `----------------------------------------`,
    `From: ${name} <${email}>`,
    phone ? `Phone: ${phone}` : null,
    `Subject: ${subject}`,
    ``,
    `Message:`,
    message,
    ``,
    `----------------------------------------`,
    `Reply to this email to contact ${name} directly.`,
  ]
    .filter(Boolean)
    .join("\n");

  const adminHtml = renderAdminContactHtml({ name, email, phone, subject, message, type: "Contact" });

  const userSubject = `We received your message - ${config.brandName}`;
  const userText = [
    `Hello ${name},`,
    ``,
    `Thank you for contacting ${config.brandName}. We have received your message regarding "${subject}".`,
    `Our team is reviewing it and will get back to you shortly (usually within 4 business hours).`,
    ``,
    `Best regards,`,
    `${config.brandName} Team`,
  ].join("\n");

  const userHtml = renderUserAckHtml({ name, isEnquiry: false });

  let adminDelivery = { delivered: false };
  let userDelivery = { delivered: false };

  try {
    adminDelivery = await mailService.send({
      to: config.contactUsEmail,
      replyTo: email,
      subject: adminSubject,
      text: adminText,
      html: adminHtml,
    });
  } catch (err) {
    console.error("[contactService] Failed to send admin contact email:", err.message);
  }

  try {
    userDelivery = await mailService.send({
      to: email,
      replyTo: config.contactUsEmail,
      subject: userSubject,
      text: userText,
      html: userHtml,
    });
  } catch (err) {
    console.error("[contactService] Failed to send user contact ack email:", err.message);
  }

  return {
    ok: true,
    adminDelivery,
    userDelivery,
  };
}

async function sendEnquiryMessage(data) {
  const { name, company, email, phone, category, quantity, city, notes } = data;
  const adminSubject = `[Corporate Quote Enquiry] ${company} - ${name}`;
  const adminText = [
    `New corporate gifting enquiry on ${config.brandName}`,
    `----------------------------------------`,
    `Contact Name: ${name}`,
    `Company: ${company}`,
    `Email: ${email}`,
    `Phone: ${phone}`,
    category ? `Category: ${category}` : null,
    quantity ? `Estimated Quantity: ${quantity}` : null,
    city ? `Delivery City: ${city}` : null,
    notes ? `\nRequirements / Notes:\n${notes}` : null,
    ``,
    `----------------------------------------`,
    `Reply to this email to contact ${name} at <${email}>.`,
  ]
    .filter(Boolean)
    .join("\n");

  const adminHtml = renderAdminEnquiryHtml({ name, company, email, phone, category, quantity, city, notes });

  const userSubject = `We received your corporate quote request - ${config.brandName}`;
  const userText = [
    `Hello ${name},`,
    ``,
    `Thank you for requesting a corporate gifting quote from ${config.brandName}.`,
    `We have received your requirements for ${company} and our team will prepare a quotation for you shortly (usually within 4 business hours).`,
    ``,
    `Best regards,`,
    `${config.brandName} Corporate Sales`,
  ].join("\n");

  const userHtml = renderUserAckHtml({ name, isEnquiry: true });

  let adminDelivery = { delivered: false };
  let userDelivery = { delivered: false };

  try {
    adminDelivery = await mailService.send({
      to: config.contactUsEmail,
      replyTo: email,
      subject: adminSubject,
      text: adminText,
      html: adminHtml,
    });
  } catch (err) {
    console.error("[contactService] Failed to send admin enquiry email:", err.message);
  }

  try {
    userDelivery = await mailService.send({
      to: email,
      replyTo: config.contactUsEmail,
      subject: userSubject,
      text: userText,
      html: userHtml,
    });
  } catch (err) {
    console.error("[contactService] Failed to send user enquiry ack email:", err.message);
  }

  return {
    ok: true,
    adminDelivery,
    userDelivery,
  };
}

module.exports = {
  sendContactMessage,
  sendEnquiryMessage,
  renderAdminContactHtml,
  renderAdminEnquiryHtml,
  renderUserAckHtml,
};
