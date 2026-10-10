// /api/v1/account - signed-in user's profile, addresses, wishlist, notifications.
const router = require("express").Router();
const c = require("../Controllers/accountController");
const v = require("../Validators/commerceValidators");
const { validate } = require("../Middleware/validate");
const { requireAuth } = require("../Middleware/auth");

router.use(requireAuth);
router.get("/summary", c.summary);
router.put("/profile", validate({ body: v.profile }), c.updateProfile);
router.get("/addresses", c.addresses);
router.post("/addresses", validate({ body: v.addressBody }), c.createAddress);
router.put("/addresses/:id", validate({ params: v.idParam, body: v.addressBody }), c.updateAddress);
router.delete("/addresses/:id", validate({ params: v.idParam }), c.deleteAddress);
router.get("/wishlist", c.wishlist);
router.post("/wishlist/:id", validate({ params: v.idParam }), c.addWishlist);
router.delete("/wishlist/:id", validate({ params: v.idParam }), c.removeWishlist);
router.get("/notifications", c.notifications);
router.post("/notifications/read", c.readNotifications);

module.exports = router;
