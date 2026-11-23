const express = require("express");
const {
  getMeta,
  updateStore,
  getBillingHistory,
  getSmsSettings,
  updateSmsSettings,
  getSmsLog,
  sendTestSms,
  createRole,
  updateRole,
  deleteRole,
  createUser,
  updateUser,
  clearData,
  getNotifications,
} = require("../controllers/settings.controller");
const { applySetup, skipSetup } = require("../controllers/setup.controller");
const authenticateJWT = require("../middlewares/authenticateJWT");
const authorizePermission = require("../middlewares/authorizePermission");

const router = express.Router();

// app shell: every signed-in user
router.get("/meta", authenticateJWT, getMeta);
router.get("/notifications", authenticateJWT, getNotifications);

// shop details printed on receipts; plan and modules are set by the platform
router.patch("/store", authenticateJWT, authorizePermission("settings:edit"), updateStore);
router.get("/sms", authenticateJWT, authorizePermission("settings"), getSmsSettings);
router.patch("/sms", authenticateJWT, authorizePermission("settings:edit"), updateSmsSettings);
router.get("/sms/log", authenticateJWT, authorizePermission("settings"), getSmsLog);
router.post("/sms/test", authenticateJWT, authorizePermission("settings:edit"), sendTestSms);
router.get("/billing", authenticateJWT, authorizePermission("settings"), getBillingHistory);

router.post("/role", authenticateJWT, authorizePermission("settings:edit"), createRole);
router.patch("/role/:id", authenticateJWT, authorizePermission("settings:edit"), updateRole);
router.delete("/role/:id", authenticateJWT, authorizePermission("settings:edit"), deleteRole);

router.post("/user", authenticateJWT, authorizePermission("settings:edit"), createUser);
router.patch("/user/:id", authenticateJWT, authorizePermission("settings:edit"), updateUser);

// setup assistant of a new shop (can be run again from Settings)
router.post("/setup", authenticateJWT, authorizePermission("settings:edit"), applySetup);
router.post("/setup/skip", authenticateJWT, authorizePermission("settings:edit"), skipSetup);

router.post("/clearData", authenticateJWT, authorizePermission("settings:edit"), clearData);

module.exports = router;
