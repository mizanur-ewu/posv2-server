const express = require("express");
const {
  getAllStock,
  getStockById,
  createStock,
  updateStock,
  deleteStock,
  checkPriceConflicts,
  getSkus,
  getLots,
  lookupCode,
} = require("../controllers/stock.controller");
const authenticateJWT = require("../middlewares/authenticateJWT");
const authorizePermission = require("../middlewares/authorizePermission");

const router = express.Router();

// SKUs, lots and the scanner lookup are used by POS, orders, sales out, stock and inventory pages
router.get("/sku", authenticateJWT, getSkus);
router.get("/sku/:id/lots", authenticateJWT, getLots);
router.get("/lookup", authenticateJWT, lookupCode);

router.post("/checkPriceConflicts", authenticateJWT, authorizePermission("stock:create", "stock:edit"), checkPriceConflicts);

// stock entries
router.get("/", authenticateJWT, authorizePermission("stock"), getAllStock);
router.get("/:id", authenticateJWT, authorizePermission("stock"), getStockById);
router.post("/", authenticateJWT, authorizePermission("stock:create"), createStock);
router.patch("/:id", authenticateJWT, authorizePermission("stock:edit"), updateStock);
router.delete("/:id", authenticateJWT, authorizePermission("stock:delete"), deleteStock);

module.exports = router;
