const dayjs = require("dayjs");
const bcrypt = require("bcryptjs");
const { logger } = require("../utils/logger");
const { prisma } = require("../config/db");
const apiError = require("../utils/apiError");
const { r2, normEmail, normPhone, tenant, indexBy } = require("../utils/helperFunction");
const { safeUser } = require("../utils/viewHelper");
const { checkUnique, checkPassword } = require("./settings.controller");
const { checkUserLimit } = require("../utils/platform");

/** SRs and delivery men with their login, open issues, shortages and routes. */
exports.getAllEmployees = async (req, res, next) => {
  try {
    const where = { storeId: req.storeId };
    const [employees, users, issues, shortages, routes] = await Promise.all([
      prisma.employee.findMany({ where, orderBy: { createdAt: "asc" } }),
      prisma.user.findMany({ where }),
      prisma.productIssue.findMany({ where, select: { employeeId: true, status: true, cashShortExcess: true } }),
      prisma.stockAdjustment.groupBy({ by: ["employeeId"], where: { ...where, employeeId: { not: null } }, _sum: { amount: true } }),
      prisma.route.findMany({ where, select: { name: true, srId: true } }),
    ]);
    const U = indexBy(users);
    const data = employees.map((e) => {
      const own = issues.filter((i) => i.employeeId === e.id);
      const user = e.userId ? U.get(e.userId) : null;
      return {
        ...e,
        user: user ? safeUser(user) : null,
        openIssues: own.filter((i) => i.status === "open").length,
        totalIssues: own.length,
        shortageCharged: r2(shortages.find((s) => s.employeeId === e.id)?._sum.amount || 0),
        cashShortExcess: r2(own.reduce((a, i) => a + (i.status === "settled" ? i.cashShortExcess : 0), 0)),
        routes: routes.filter((r) => r.srId === e.id).map((r) => r.name),
      };
    });
    return res.status(200).json({ status: "success", results: data.length, data });
  } catch (error) {
    logger.error(`Employees retrieval error: ${error.message}`);
    next(error);
  }
};

/**
 * Create or update an SR / delivery man.
 * - An order-taking SR always has a login: phone (required, used to log in), optional email and a
 *   password (required the first time; on edit a new one replaces it). The user gets the SR role.
 * - A van SR (takes products in the morning) never logs in: an old login is switched off.
 * - Delivery men keep the optional "linked app user" (userId).
 * The login follows the employee's active / inactive status.
 */
const saveEmployee = async (req, id) => {
  const { email, password, ...e } = req.body;
  const name = String(e.name || "").trim();
  if (!name) throw apiError.badRequest("Name is required");
  if (!["sr", "delivery_man"].includes(e.type)) throw apiError.badRequest("Select the employee type");
  const existing = id ? await prisma.employee.findFirst({ where: { id, storeId: req.storeId } }) : null;
  if (id && !existing) throw apiError.notFound("Employee not found");
  const status = e.status === "inactive" ? "inactive" : e.status === "active" ? "active" : existing?.status || "active";
  const srMode = e.type === "sr" ? (e.srMode === "orders" ? "orders" : "sells") : null;

  let userId = e.type === "delivery_man" ? e.userId || null : existing?.userId || null;
  if (e.type === "delivery_man" && userId && !(await prisma.user.findFirst({ where: { id: userId, storeId: req.storeId } }))) {
    throw apiError.badRequest("Linked user not found");
  }

  return prisma.$transaction(async (tx) => {
    let linked = userId ? await tx.user.findFirst({ where: { id: userId, storeId: req.storeId } }) : null;

    if (e.type === "sr" && srMode === "orders") {
      if (!e.phone) throw apiError.badRequest("Phone is required – the SR logs in with it");
      const login = {
        name,
        phone: String(e.phone).trim(),
        phoneKey: normPhone(e.phone) || null,
        email: normEmail(email) || null,
        status,
      };
      await checkUnique(tx, login, linked?.id);
      // a new SR login, or one switched back on, takes a place in the plan's user limit
      if (status === "active" && (!linked || linked.status !== "active")) await checkUserLimit(tx, req.storeId);
      if (linked) {
        const data = { ...login };
        if (password) {
          checkPassword(password);
          Object.assign(data, { password: await bcrypt.hash(String(password), 10), passwordChangedAt: dayjs().toISOString() });
        }
        await tx.user.update({ where: { id: linked.id }, data });
      } else {
        if (!password) throw apiError.badRequest("Give the SR a password to log in with");
        checkPassword(password);
        const role = await tx.role.findFirst({ where: { storeId: req.storeId, key: "sr" } });
        if (!role) throw apiError.badRequest('The "Sales Rep (SR)" role is missing. Add it under Settings → Roles.');
        linked = await tx.user.create({
          data: { ...tenant(req), ...login, roleId: role.id, loginWith: "phone", password: await bcrypt.hash(String(password), 10) },
        });
        userId = linked.id;
      }
    } else if (e.type === "sr" && linked) {
      // a van SR cannot log in; switching back to "takes orders" turns it on again
      await tx.user.update({ where: { id: linked.id }, data: { status: "inactive" } });
    }

    const data = { type: e.type, srMode, name, phone: e.phone ? String(e.phone).trim() : null, status, userId };
    if (existing) return tx.employee.update({ where: { id: existing.id }, data });
    return tx.employee.create({ data: { ...tenant(req), ...data } });
  });
};

exports.createEmployee = async (req, res, next) => {
  try {
    const employee = await saveEmployee(req);
    return res.status(201).json({ status: "success", message: "Saved", data: employee });
  } catch (error) {
    logger.error(`Employee creation error: ${error.message}`);
    next(error);
  }
};

exports.updateEmployee = async (req, res, next) => {
  try {
    const employee = await saveEmployee(req, req.params.id);
    return res.status(200).json({ status: "success", message: "Saved", data: employee });
  } catch (error) {
    logger.error(`Employee update error: ${error.message}`);
    next(error);
  }
};
