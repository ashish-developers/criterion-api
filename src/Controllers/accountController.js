const accountService = require("../Services/accountService");
const cartService = require("../Services/cartService");
const { ok, created } = require("../Utils/http");

module.exports = {
  updateProfile: async (req, res) => {
    const user = await accountService.updateProfile(req.auth.user.id, req.body);
    return ok(res, { id: user.id, name: user.name, phone: user.phone, marketing_opt_in: user.marketing_opt_in }, "Profile updated");
  },
  summary: async (req, res) => {
    const [notifications, cartCount] = await Promise.all([accountService.notifications(req.auth.user.id, { limit: 5 }), cartService.count(req.auth.user.id)]);
    return ok(res, { unreadNotifications: notifications.unread, cartCount });
  },
  addresses: async (req, res) => ok(res, await accountService.listAddresses(req.auth)),
  createAddress: async (req, res) => created(res, await accountService.saveAddress(req.auth, req.body), "Address saved"),
  updateAddress: async (req, res) => ok(res, await accountService.saveAddress(req.auth, req.body, req.params.id), "Address updated"),
  deleteAddress: async (req, res) => {
    await accountService.deleteAddress(req.auth, req.params.id);
    return ok(res, null, "Address removed");
  },
  wishlist: async (req, res) => ok(res, await accountService.wishlist(req.auth.user.id)),
  addWishlist: async (req, res) => {
    await accountService.addToWishlist(req.auth.user.id, req.params.id);
    return ok(res, null, "Added to wishlist");
  },
  removeWishlist: async (req, res) => {
    await accountService.removeFromWishlist(req.auth.user.id, req.params.id);
    return ok(res, null, "Removed from wishlist");
  },
  notifications: async (req, res) => ok(res, await accountService.notifications(req.auth.user.id, { limit: Math.min(100, Number(req.query.limit) || 20) })),
  readNotifications: async (req, res) => {
    await accountService.markNotificationsRead(req.auth.user.id, Array.isArray(req.body?.ids) ? req.body.ids.map(Number).filter(Boolean) : null);
    return ok(res, null, "Marked as read");
  },
};
