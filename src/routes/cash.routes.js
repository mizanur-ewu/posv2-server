const express = require("express");
const { getDay, closeDay, listClosings, reopenDay, getCashBook } = require("../controllers/cash.controller");
const authenticateJWT = require("../middlewares/authenticateJWT");
const authorizePermission = require("../middlewares/authorizePermission");

const router = express.Router();

// day-end cash closing: cashiers close their own drawer (create), managers see and close all (view)
router.get("/closing/day", authenticateJWT, authorizePermission("cashClosing:create", "cashClosing"), getDay);
router.post("/closing", authenticateJWT, authorizePermission("cashClosing:create"), closeDay);
router.get("/closing", authenticateJWT, authorizePermission("cashClosing:create", "cashClosing"), listClosings);
router.delete("/closing/:id", authenticateJWT, authorizePermission("cashClosing:delete"), reopenDay);

// cash book / day book
router.get("/book", authenticateJWT, authorizePermission("reports", "cashClosing"), getCashBook);

module.exports = router;
