const express = require("express");
const { getDashboard } = require("../controllers/dashboard/dashboard.controller");
const authenticateJWT = require("../middlewares/authenticateJWT");
const authorizePermission = require("../middlewares/authorizePermission");

const router = express.Router();

router.get("/", authenticateJWT, authorizePermission("dashboard"), getDashboard);

module.exports = router;
