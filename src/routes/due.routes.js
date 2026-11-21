const express = require("express");
const {
  getDues,
  getStaffParties,
  addStaffDue,
  deleteStaffDueEntry,
  collectDue,
  getDueCollections,
  sendDueReminders,
} = require("../controllers/due.controller");
const authenticateJWT = require("../middlewares/authenticateJWT");
const authorizePermission = require("../middlewares/authorizePermission");

const router = express.Router();

router.get("/", authenticateJWT, authorizePermission("customerDues"), getDues);
router.get("/collections", authenticateJWT, authorizePermission("customerDues"), getDueCollections);
router.get("/staffParties", authenticateJWT, authorizePermission("customerDues:create"), getStaffParties);
router.post("/staff", authenticateJWT, authorizePermission("customerDues:create"), addStaffDue);
router.delete("/staff/:id", authenticateJWT, authorizePermission("customerDues:delete"), deleteStaffDueEntry);
router.post("/remind", authenticateJWT, authorizePermission("customerDues:create"), sendDueReminders);
router.post("/collect", authenticateJWT, authorizePermission("customerDues:create"), collectDue);

module.exports = router;
