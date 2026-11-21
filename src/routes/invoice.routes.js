const express = require("express");
const {
  getAllInvoices,
  getInvoiceById,
  getInvoiceByNo,
  createPosInvoice,
  receivePayment,
  deleteInvoice,
} = require("../controllers/invoice.controller");
const authenticateJWT = require("../middlewares/authenticateJWT");
const authorizePermission = require("../middlewares/authorizePermission");

const router = express.Router();

router.get("/", authenticateJWT, authorizePermission("invoices", "customerDues"), getAllInvoices);
router.get("/byNo/:no", authenticateJWT, authorizePermission("invoices", "returns"), getInvoiceByNo);
router.get("/:id", authenticateJWT, authorizePermission("invoices", "returns", "pos:create", "customerDues"), getInvoiceById);
router.post("/pos", authenticateJWT, authorizePermission("pos:create"), createPosInvoice);
router.post("/:id/payment", authenticateJWT, authorizePermission("invoices", "customerDues:create"), receivePayment);
router.delete("/:id", authenticateJWT, authorizePermission("invoices:delete"), deleteInvoice);

module.exports = router;
