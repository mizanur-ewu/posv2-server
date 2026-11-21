const express = require("express");
const {
  getAllIssues,
  getIssueById,
  createIssue,
  cancelIssue,
  deleteIssue,
  settleIssue,
  getSettlementDraft,
  updateSettlement,
  deleteSettlement,
} = require("../controllers/productIssue.controller");
const authenticateJWT = require("../middlewares/authenticateJWT");
const authorizePermission = require("../middlewares/authorizePermission");

const router = express.Router();

// sales out
router.get("/", authenticateJWT, authorizePermission("issues", "settlement"), getAllIssues);
router.get("/:id", authenticateJWT, authorizePermission("issues", "settlement"), getIssueById);
router.post("/", authenticateJWT, authorizePermission("issues:create"), createIssue);
router.post("/:id/cancel", authenticateJWT, authorizePermission("issues:cancel"), cancelIssue);
router.delete("/:id", authenticateJWT, authorizePermission("issues:delete"), deleteIssue);

// sales return (day-end settlement)
router.post("/:id/settle", authenticateJWT, authorizePermission("settlement:create"), settleIssue);
router.get("/:id/settlementDraft", authenticateJWT, authorizePermission("settlement:edit"), getSettlementDraft);
router.patch("/:id/settlement", authenticateJWT, authorizePermission("settlement:edit"), updateSettlement);
router.delete("/:id/settlement", authenticateJWT, authorizePermission("settlement:delete"), deleteSettlement);

module.exports = router;
