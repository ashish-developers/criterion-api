// Visiting card module constants shared by validators and services. The web app keeps the
// same lists in ui/features/visiting-cards/model.ts; change both together.

// Fonts a card may use. Nunito and Poppins are loaded by the site theme; the rest are
// standard system fonts, so screen previews match the print proof.
const FONTS = ["Nunito", "Poppins", "Arial", "Georgia", "Times New Roman", "Trebuchet MS", "Verdana", "Courier New"];

// Card details. Corporate orders hold company-wide values here and per-person values in
// each employee row (EMPLOYEE_FIELDS), which override them on that person's card.
const CARD_FIELDS = {
  fullName: 120,
  designation: 120,
  department: 120,
  company: 160,
  tagline: 160,
  mobile: 30,
  phone: 30,
  email: 190,
  website: 200,
  address: 300,
};
const EMPLOYEE_FIELDS = ["employeeCode", "fullName", "designation", "department", "mobile", "phone", "email", "address"];

// Colour tokens resolve against the design's theme, so changing a brand colour recolours
// every element that uses it.
const COLOR_TOKENS = ["primary", "secondary", "text", "muted", "background"];
const FONT_TOKENS = ["heading", "body"];

const ORDER_STATUSES = ["pending", "artwork_review", "approved", "in_production", "dispatched", "delivered", "cancelled"];

// Stages staff can move an order to by hand. Payment moves pending -> artwork_review, and the
// artwork decision moves artwork_review -> approved; those have their own endpoints.
const STATUS_TRANSITIONS = {
  approved: ["in_production"],
  in_production: ["dispatched"],
  dispatched: ["delivered"],
};

// Customers may cancel until they pay; after that only staff can (with an optional refund).
const STAFF_CANCELLABLE = ["pending", "artwork_review", "approved", "in_production"];

const PRINT_OPTION_GROUPS = { paper: "Paper stock", finish: "Finish", corners: "Corners" };

module.exports = { FONTS, CARD_FIELDS, EMPLOYEE_FIELDS, COLOR_TOKENS, FONT_TOKENS, ORDER_STATUSES, STATUS_TRANSITIONS, STAFF_CANCELLABLE, PRINT_OPTION_GROUPS };
