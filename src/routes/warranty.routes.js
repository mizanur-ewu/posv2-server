const express = require("express");
const { lookup, listSerials, available, soldOnInvoice, listClaims, createClaim, updateClaim } = require("../controllers/warranty.controller");
const authenticateJWT = require("../middlewares/authenticateJWT");
const authorizePermission = require("../middlewares/authorizePermission");

const router = express.Router();

// IMEI / serial register and warranty lookup
router.get("/lookup", authenticateJWT, authorizePermission("warranty"), lookup);
router.get("/serials", authenticateJWT, authorizePermission("warranty", "inventory"), listSerials);
// pickers used by POS, customer returns and stock adjustments
router.get("/available", authenticateJWT, authorizePermission("pos:create", "adjustments:create", "warranty"), available);
router.get("/sold/:invoiceId", authenticateJWT, authorizePermission("returns:create", "invoices", "warranty"), soldOnInvoice);

// warranty claims
router.get("/claims", authenticateJWT, authorizePermission("warranty"), listClaims);
router.post("/claims", authenticateJWT, authorizePermission("warranty:create"), createClaim);
router.patch("/claims/:id", authenticateJWT, authorizePermission("warranty:edit"), updateClaim);

module.exports = router;
