const express = require("express");
const { authenticatePlatform, requireOwner } = require("../middlewares/authenticatePlatform");
const shops = require("../controllers/platform/shops.controller");
const billing = require("../controllers/platform/billing.controller");
const admin = require("../controllers/platform/admin.controller");
const smsAdmin = require("../controllers/platform/sms.controller");

/**
 * Admin console of the SaaS platform. Every route needs a platform token.
 * Owners can do everything; support people can look, open shops, record payments and extend dates.
 */
const router = express.Router();
router.use(authenticatePlatform);

router.get("/me", admin.getMe);
router.post("/me/password", admin.changeMyPassword);
router.get("/overview", admin.getOverview);

router.get("/shops", shops.listShops);
router.post("/shops", shops.createShop);
router.get("/shops/:id", shops.getShop);
router.patch("/shops/:id", shops.updateShop);
router.patch("/shops/:id/dates", shops.setDates);
router.post("/shops/:id/suspend", shops.suspendShop);
router.post("/shops/:id/activate", shops.activateShop);
router.post("/shops/:id/open", shops.openShop);
router.post("/shops/:id/users/:userId/password", shops.resetUserPassword);
router.patch("/shops/:id/users/:userId", shops.updateShopUser);
router.delete("/shops/:id", requireOwner, shops.deleteShop);
router.post("/shops/:id/sms-credits", smsAdmin.addShopCredits);

router.get("/sms", smsAdmin.getSmsOverview);
router.patch("/sms", requireOwner, smsAdmin.updateSmsSettings);
router.post("/sms/test", smsAdmin.sendTestSms);

router.get("/plans", billing.listPlans);
router.post("/plans", requireOwner, billing.createPlan);
router.patch("/plans/:id", requireOwner, billing.updatePlan);
router.delete("/plans/:id", requireOwner, billing.deletePlan);

router.get("/payments", billing.listPayments);
router.post("/payments", billing.recordPayment);
router.delete("/payments/:id", requireOwner, billing.deletePayment);

router.get("/announcements", admin.listAnnouncements);
router.post("/announcements", requireOwner, admin.createAnnouncement);
router.patch("/announcements/:id", requireOwner, admin.updateAnnouncement);
router.delete("/announcements/:id", requireOwner, admin.deleteAnnouncement);

router.get("/team", admin.listTeam);
router.post("/team", requireOwner, admin.saveTeamMember);
router.patch("/team/:id", requireOwner, admin.saveTeamMember);

router.get("/audit", admin.listAudit);

router.get("/settings", admin.getSettings);
router.patch("/settings", requireOwner, admin.updateSettings);

module.exports = router;
