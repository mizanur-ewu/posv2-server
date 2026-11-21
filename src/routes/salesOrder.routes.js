const express = require("express");
const {
  getAllOrders,
  createOrder,
  updateOrder,
  cancelOrder,
  deleteOrder,
  deliverOrder,
} = require("../controllers/salesOrder.controller");
const authenticateJWT = require("../middlewares/authenticateJWT");
const authorizePermission = require("../middlewares/authorizePermission");

const router = express.Router();

router.get("/", authenticateJWT, authorizePermission("orders", "myOrders", "issues"), getAllOrders);
router.post("/", authenticateJWT, authorizePermission("orders:create", "myOrders:create"), createOrder);
router.patch("/:id", authenticateJWT, authorizePermission("orders:edit"), updateOrder);
router.post("/:id/cancel", authenticateJWT, authorizePermission("orders:cancel", "myOrders:cancel"), cancelOrder);
router.post("/:id/deliver", authenticateJWT, authorizePermission("issues", "settlement:create"), deliverOrder);
router.delete("/:id", authenticateJWT, authorizePermission("orders:delete"), deleteOrder);

module.exports = router;
