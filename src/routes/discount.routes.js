const express = require("express");
const { getAllDiscounts, createDiscount, updateDiscount, endDiscount } = require("../controllers/discount.controller");
const authenticateJWT = require("../middlewares/authenticateJWT");
const authorizePermission = require("../middlewares/authorizePermission");

const router = express.Router();

router.get("/", authenticateJWT, authorizePermission("discounts"), getAllDiscounts);
router.post("/", authenticateJWT, authorizePermission("discounts:create"), createDiscount);
router.patch("/:id", authenticateJWT, authorizePermission("discounts:edit"), updateDiscount);
router.post("/:id/end", authenticateJWT, authorizePermission("discounts:edit"), endDiscount);

module.exports = router;
