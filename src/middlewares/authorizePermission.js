const { roleCan } = require("../utils/permissions");

/**
 * Page / action permission check (dynamic roles), e.g.
 *   authorizePermission("stock:create")
 *   authorizePermission("orders:create", "myOrders:create")   – any one of them is enough
 * A rule without an action means "view". The store's subscription plan must also open the page.
 */
const authorizePermission = (...rules) => {
  return (req, res, next) => {
    const allowed = rules.some((rule) => {
      const [page, action = "view"] = rule.split(":");
      return roleCan(req.role, req.subscription, page, action);
    });
    if (!req.user || !req.user.id || !allowed) {
      return res.status(403).json({ status: "error", message: "Access denied" });
    }
    next();
  };
};

module.exports = authorizePermission;
