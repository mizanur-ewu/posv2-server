const dayjs = require("dayjs");
const { logger } = require("../utils/logger");
const { prisma } = require("../config/db");
const apiError = require("../utils/apiError");
const { r2, toDate, tenant, indexBy } = require("../utils/helperFunction");

/* ---------------- expense categories ---------------- */

/** Expense categories with how many expenses use each and their total. */
exports.getAllExpenseCategories = async (req, res, next) => {
  try {
    const where = { storeId: req.storeId };
    const [list, sums] = await Promise.all([
      prisma.expenseCategory.findMany({ where, orderBy: { name: "asc" } }),
      prisma.expense.groupBy({ by: ["categoryId"], where, _count: { _all: true }, _sum: { amount: true } }),
    ]);
    const data = list.map((c) => {
      const s = sums.find((x) => x.categoryId === c.id);
      return { ...c, expenseCount: s?._count._all || 0, total: r2(s?._sum.amount || 0) };
    });
    return res.status(200).json({ status: "success", data });
  } catch (error) {
    logger.error(`Expense categories retrieval error: ${error.message}`);
    next(error);
  }
};

const checkCategoryName = async (storeId, name, exceptId) => {
  if (!name) throw apiError.badRequest("Name is required");
  const dup = await prisma.expenseCategory.findFirst({
    where: { storeId, name: { equals: name, mode: "insensitive" }, ...(exceptId ? { id: { not: exceptId } } : {}) },
    select: { id: true },
  });
  if (dup) throw apiError.conflict(`Expense category "${name}" already exists`);
};

exports.createExpenseCategory = async (req, res, next) => {
  try {
    const name = String(req.body.name || "").trim();
    await checkCategoryName(req.storeId, name);
    const category = await prisma.expenseCategory.create({ data: { ...tenant(req), name } });
    return res.status(201).json({ status: "success", message: "Expense category created", data: category });
  } catch (error) {
    logger.error(`Expense category creation error: ${error.message}`);
    next(error);
  }
};

exports.updateExpenseCategory = async (req, res, next) => {
  try {
    const id = req.params.id;
    const name = String(req.body.name || "").trim();
    if (!(await prisma.expenseCategory.findFirst({ where: { id, storeId: req.storeId } }))) throw apiError.notFound("Expense category not found");
    await checkCategoryName(req.storeId, name, id);
    const category = await prisma.expenseCategory.update({ where: { id }, data: { name } });
    return res.status(200).json({ status: "success", message: "Expense category updated", data: category });
  } catch (error) {
    logger.error(`Expense category update error: ${error.message}`);
    next(error);
  }
};

exports.deleteExpenseCategory = async (req, res, next) => {
  try {
    const id = req.params.id;
    if (!(await prisma.expenseCategory.findFirst({ where: { id, storeId: req.storeId } }))) throw apiError.notFound("Expense category not found");
    const used = await prisma.expense.count({ where: { storeId: req.storeId, categoryId: id } });
    if (used) throw apiError.badRequest(`Used by ${used} expense(s). Move them first.`);
    await prisma.expenseCategory.delete({ where: { id } });
    return res.status(200).json({ status: "success", message: "Expense category deleted", data: null });
  } catch (error) {
    logger.error(`Expense category delete error: ${error.message}`);
    next(error);
  }
};

/* ---------------- expenses ---------------- */

exports.getAllExpenses = async (req, res, next) => {
  try {
    const where = { storeId: req.storeId };
    const [list, categories, methods, users] = await Promise.all([
      prisma.expense.findMany({ where, orderBy: [{ date: "desc" }, { createdAt: "desc" }] }),
      prisma.expenseCategory.findMany({ where, select: { id: true, name: true } }),
      prisma.paymentMethod.findMany(),
      prisma.user.findMany({ where, select: { id: true, name: true } }),
    ]);
    const C = indexBy(categories);
    const M = indexBy(methods);
    const U = indexBy(users);
    const data = list.map((x) => ({
      ...x,
      category: C.get(x.categoryId)?.name || "—",
      method: M.get(x.paymentMethodId)?.name || "—",
      createdBy: U.get(x.createdById)?.name || "—",
    }));
    return res.status(200).json({ status: "success", results: data.length, data });
  } catch (error) {
    logger.error(`Expenses retrieval error: ${error.message}`);
    next(error);
  }
};

exports.getExpenseById = async (req, res, next) => {
  try {
    const expense = await prisma.expense.findFirst({ where: { id: req.params.id, storeId: req.storeId } });
    if (!expense) throw apiError.notFound("Expense not found");
    return res.status(200).json({ status: "success", data: expense });
  } catch (error) {
    logger.error(`Expense retrieval error: ${error.message}`);
    next(error);
  }
};

const expenseFields = async (req) => {
  const { categoryId, amount, date, paymentMethodId, remark } = req.body;
  if (!categoryId || !(await prisma.expenseCategory.findFirst({ where: { id: categoryId, storeId: req.storeId } }))) {
    throw apiError.badRequest("Choose an expense category");
  }
  if (!(Number(amount) > 0)) throw apiError.badRequest("Enter an amount");
  if (paymentMethodId && !(await prisma.paymentMethod.findUnique({ where: { id: paymentMethodId } }))) {
    throw apiError.badRequest("Select a payment method");
  }
  return {
    categoryId,
    amount: r2(amount),
    date: toDate(date || dayjs()),
    paymentMethodId: paymentMethodId || null,
    remark: String(remark || "").trim(),
  };
};

exports.createExpense = async (req, res, next) => {
  try {
    const fields = await expenseFields(req);
    const expense = await prisma.expense.create({ data: { ...tenant(req), ...fields, createdById: req.user.id } });
    return res.status(201).json({ status: "success", message: "Expense saved", data: expense });
  } catch (error) {
    logger.error(`Expense creation error: ${error.message}`);
    next(error);
  }
};

exports.updateExpense = async (req, res, next) => {
  try {
    const id = req.params.id;
    if (!(await prisma.expense.findFirst({ where: { id, storeId: req.storeId } }))) throw apiError.notFound("Expense not found");
    const fields = await expenseFields(req);
    const expense = await prisma.expense.update({ where: { id }, data: { ...fields, updatedById: req.user.id } });
    return res.status(200).json({ status: "success", message: "Expense updated", data: expense });
  } catch (error) {
    logger.error(`Expense update error: ${error.message}`);
    next(error);
  }
};

exports.deleteExpense = async (req, res, next) => {
  try {
    const id = req.params.id;
    if (!(await prisma.expense.findFirst({ where: { id, storeId: req.storeId } }))) throw apiError.notFound("Expense not found");
    await prisma.expense.delete({ where: { id } });
    return res.status(200).json({ status: "success", message: "Expense deleted", data: null });
  } catch (error) {
    logger.error(`Expense delete error: ${error.message}`);
    next(error);
  }
};
