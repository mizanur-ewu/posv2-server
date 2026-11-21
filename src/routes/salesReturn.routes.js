const express = require("express");
const { getAllReturns, createReturn } = require("../controllers/salesReturn.controller");
const authenticateJWT = require("../middlewares/authenticateJWT");
const authorizePermission = require("../middlewares/authorizePermission");

const router = express.Router();

router.get("/", authenticateJWT, authorizePermission("returns"), getAllReturns);
router.post("/", authenticateJWT, authorizePermission("returns:create"), createReturn);

module.exports = router;
