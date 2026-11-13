const contactService = require("../Services/contactService");
const { ok } = require("../Utils/http");

module.exports = {
  submitContact: async (req, res) => {
    const result = await contactService.sendContactMessage(req.body);
    return ok(res, result, "Thank you! Your message has been sent. We will get back to you soon.");
  },
  submitEnquiry: async (req, res) => {
    const result = await contactService.sendEnquiryMessage(req.body);
    return ok(res, result, "Thank you! Your quote enquiry has been received. Our team will contact you soon.");
  },
};
