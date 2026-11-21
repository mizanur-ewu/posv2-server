const express = require("express");
const {
  getAllExpenseCategories,
  createExpenseCategory,
  updateExpenseCategory,
  deleteExpenseCategory,
  getAllExpenses,
  getExpenseById,
  createExpense,
  updateExpense,
  deleteExpense,
} = require("../controllers/expense.controller");
const authenticateJWT = require("../middlewares/authenticateJWT");
const authorizePermission = require("../middlewares/authorizePermission");

const router = express.Router();

// expense categories
router.get("/category", authenticateJWT, authorizePermission("expenses"), getAllExpenseCategories);
router.post("/category", authenticateJWT, authorizePermission("expenses:create"), createExpenseCategory);
router.patch("/category/:id", authenticateJWT, authorizePermission("expenses:edit"), updateExpenseCategory);
router.delete("/category/:id", authenticateJWT, authorizePermission("expenses:delete", "expenses:edit"), deleteExpenseCategory);

// expenses
router.get("/", authenticateJWT, authorizePermission("expenses"), getAllExpenses);
router.get("/:id", authenticateJWT, authorizePermission("expenses"), getExpenseById);
router.post("/", authenticateJWT, authorizePermission("expenses:create"), createExpense);
router.patch("/:id", authenticateJWT, authorizePermission("expenses:edit"), updateExpense);
router.delete("/:id", authenticateJWT, authorizePermission("expenses:delete"), deleteExpense);

module.exports = router;
