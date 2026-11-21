const express = require("express");
const {
  getAdjustmentTypes,
  getAllAdjustments,
  createAdjustment,
  adjustStockEntry,
  updateAdjustment,
  deleteAdjustment,
} = require("../controllers/adjustment.controller");
const authenticateJWT = require("../middlewares/authenticateJWT");
const authorizePermission = require("../middlewares/authorizePermission");

const router = express.Router();

router.get("/types", authenticateJWT, getAdjustmentTypes);
router.get("/", authenticateJWT, authorizePermission("adjustments"), getAllAdjustments);
router.post("/", authenticateJWT, authorizePermission("adjustments:create"), createAdjustment);
router.post("/stockEntry", authenticateJWT, authorizePermission("adjustments:create"), adjustStockEntry);
router.patch("/:id", authenticateJWT, authorizePermission("adjustments:edit"), updateAdjustment);
router.delete("/:id", authenticateJWT, authorizePermission("adjustments:delete"), deleteAdjustment);

module.exports = router;
