const express = require("express");
const {
  createSupplier,
  updateSupplier,
  getSupplierPayments,
  addSupplierPayment,
  getSupplierDues,
} = require("../controllers/supplier.controller");
const authenticateJWT = require("../middlewares/authenticateJWT");
const authorizePermission = require("../middlewares/authorizePermission");

const router = express.Router();

router.get("/payments", authenticateJWT, authorizePermission("supplierPayments"), getSupplierPayments);
router.post("/payments", authenticateJWT, authorizePermission("supplierPayments:create"), addSupplierPayment);
router.get("/dues", authenticateJWT, authorizePermission("supplierPayments"), getSupplierDues);

router.post("/", authenticateJWT, authorizePermission("supplierPayments:create", "stock:create", "stock:edit"), createSupplier);
router.patch("/:id", authenticateJWT, authorizePermission("supplierPayments:create", "stock:edit"), updateSupplier);

module.exports = router;
