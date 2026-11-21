const express = require("express");
const {
  getAllCustomers,
  createCustomer,
  updateCustomer,
  createArea,
  updateArea,
  createRoute,
  updateRoute,
} = require("../controllers/customer.controller");
const authenticateJWT = require("../middlewares/authenticateJWT");
const authorizePermission = require("../middlewares/authorizePermission");

const router = express.Router();

// areas & routes
router.post("/area", authenticateJWT, authorizePermission("retailers:create", "retailers:edit"), createArea);
router.patch("/area/:id", authenticateJWT, authorizePermission("retailers:edit"), updateArea);
router.post("/route", authenticateJWT, authorizePermission("retailers:create", "retailers:edit"), createRoute);
router.patch("/route/:id", authenticateJWT, authorizePermission("retailers:edit"), updateRoute);

// customers & retailers (POS adds walk-in / regular customers, order pages add retailers)
router.get("/", authenticateJWT, getAllCustomers);
router.post("/", authenticateJWT, authorizePermission("retailers:create", "pos:create", "orders:create", "myOrders:create"), createCustomer);
router.patch("/:id", authenticateJWT, authorizePermission("retailers:edit"), updateCustomer);

module.exports = router;
