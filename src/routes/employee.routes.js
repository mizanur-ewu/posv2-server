const express = require("express");
const { getAllEmployees, createEmployee, updateEmployee } = require("../controllers/employee.controller");
const authenticateJWT = require("../middlewares/authenticateJWT");
const authorizePermission = require("../middlewares/authorizePermission");

const router = express.Router();

router.get("/", authenticateJWT, getAllEmployees);
router.post("/", authenticateJWT, authorizePermission("employees:create"), createEmployee);
router.patch("/:id", authenticateJWT, authorizePermission("employees:edit"), updateEmployee);

module.exports = router;
