const express = require("express");
const { login, logout, getDemoAccounts, changePassword, signup, getPublicInfo, forgotPassword, resetPassword } = require("../controllers/auth.controller");
const authenticateJWT = require("../middlewares/authenticateJWT");

const router = express.Router();

router.post("/login", login);
router.post("/signup", signup);
router.get("/public", getPublicInfo);
router.post("/forgot", forgotPassword);
router.post("/reset", resetPassword);
router.get("/demoAccounts", getDemoAccounts);
router.post("/logout", authenticateJWT, logout);
router.post("/changePassword", authenticateJWT, changePassword);

module.exports = router;
