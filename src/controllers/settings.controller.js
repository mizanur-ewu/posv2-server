const dayjs = require("dayjs");
const bcrypt = require("bcryptjs");
const { logger } = require("../utils/logger");
const { prisma } = require("../config/db");
const apiError = require("../utils/apiError");
const { storeTransaction } = require("../utils/storeTransaction");
const { normPhone, normEmail, tenant, toDate } = require("../utils/helperFunction");
const { getPlatformSettings, loginTaken, checkUserLimit } = require("../utils/platform");
const smsService = require("../services/sms/sms");
const { cleanPermissions, fullPermissions } = require("../utils/permissions");
const { isShopType, cleanText } = require("../utils/shopTypes");
const { shopMethodIds, cleanMethodIds } = require("../utils/stock/constants");
const { safeUser } = require("../utils/viewHelper");

const checkPassword = (pw) => {
  if (String(pw || "").length < 6) throw apiError.badRequest("Password must be at least 6 characters");
};

/** Throws when another account already has this email or phone (logins are unique across all shops and the platform). */
const checkUnique = async (client, { email, phone }, exceptId) => {
  const taken = await loginTaken(client, { email, phone }, { exceptUserId: exceptId });
  if (taken) throw apiError.conflict(taken);
};

/* ---------------- meta / session ---------------- */
/** Store, plan, master lists, users and roles – everything the app shell needs after sign in. */
exports.getMeta = async (req, res, next) => {
  try {
    const where = { storeId: req.storeId };
    const byName = { orderBy: { name: "asc" } };
    const today = toDate(dayjs());
    const [settings, announcements] = await Promise.all([
      getPlatformSettings(),
      prisma.announcement.findMany({ where: { active: true, OR: [{ endDate: null }, { endDate: { gte: today } }] }, orderBy: { createdAt: "desc" } }),
    ]);
    const [store, units, categories, brands, suppliers, paymentMethods, areas, routes, employees, users, roles] = await Promise.all([
      prisma.store.findUnique({ where: { id: req.storeId }, include: { company: { select: { name: true } }, plan: true } }),
      prisma.unit.findMany({ where, ...byName }),
      prisma.category.findMany({ where, ...byName }),
      prisma.brand.findMany({ where, ...byName }),
      prisma.supplier.findMany({ where, ...byName }),
      prisma.paymentMethod.findMany({ orderBy: { sortOrder: "asc" } }),
      prisma.area.findMany({ where, ...byName }),
      prisma.route.findMany({ where, ...byName }),
      prisma.employee.findMany({ where, orderBy: { createdAt: "asc" } }),
      prisma.user.findMany({ where, orderBy: { createdAt: "asc" } }),
      prisma.role.findMany({ where, orderBy: { createdAt: "asc" } }),
    ]);

    return res.status(200).json({
      status: "success",
      data: {
        store: { id: store.id, code: store.code, name: store.name, address: store.address, phone: store.phone, binNo: store.binNo, useVariants: store.useVariants, useSerials: store.useSerials, allowDue: store.allowDue, payMethodIds: shopMethodIds(store), shopType: store.shopType, district: store.district, thana: store.thana, setupPending: store.setupPending, smsBalance: store.smsBalance, companyId: store.companyId, companyName: store.company?.name, createdAt: store.createdAt },
        subscription: store.subscription,
        billing: {
          ...req.billing,
          plan: store.plan
            ? { name: store.plan.name, modules: store.plan.modules, maxUsers: store.plan.maxUsers, priceMonthly: Number(store.plan.priceMonthly), priceYearly: Number(store.plan.priceYearly) }
            : null,
          activeUsers: users.filter((u) => u.status === "active").length,
        },
        platform: { brandName: settings.brandName, supportPhone: settings.supportPhone, supportEmail: settings.supportEmail, paymentInfo: settings.paymentInfo },
        announcements: announcements.map(({ id, title, message, level, endDate }) => ({ id, title, message, level, endDate })),
        units,
        categories,
        brands,
        suppliers,
        paymentMethods,
        areas,
        routes,
        employees,
        users: users.map(safeUser),
        roles: roles.map((r) => (r.system ? { ...r, permissions: fullPermissions() } : r)),
        session: { userId: req.user.id, impersonatedBy: req.impersonator?.name || null },
      },
    });
  } catch (error) {
    logger.error(`Meta retrieval error: ${error.message}`);
    next(error);
  }
};

/**
 * The shop's own details printed on receipts and slips: name, address, phone.
 * (Modules and plan are set by the platform, not by the shop.)
 */
exports.updateStore = async (req, res, next) => {
  try {
    const b = req.body;
    const data = {};
    if (b.name !== undefined) {
      const name = String(b.name || "").trim();
      if (!name) throw apiError.badRequest("Enter the shop name");
      data.name = name;
    }
    ["address", "phone", "binNo"].forEach((k) => {
      if (b[k] !== undefined) data[k] = b[k] ? String(b[k]).trim() : null;
    });
    // what the shop sells (labels and setup suggestions follow it) and where it is
    if (b.shopType !== undefined) {
      if (!isShopType(b.shopType)) throw apiError.badRequest("Select the shop category");
      data.shopType = b.shopType;
    }
    ["district", "thana"].forEach((k) => {
      if (b[k] !== undefined) data[k] = cleanText(b[k]);
    });
    // optional features: product variants, IMEI / serial numbers
    if (b.useVariants !== undefined) data.useVariants = !!b.useVariants;
    if (b.useSerials !== undefined) data.useSerials = !!b.useSerials;
    // POS: sell on due or not, and the payment methods the shop takes
    if (b.allowDue !== undefined) data.allowDue = !!b.allowDue;
    if (b.payMethodIds !== undefined) data.payMethodIds = cleanMethodIds(b.payMethodIds);
    const store = await prisma.store.update({ where: { id: req.storeId }, data });
    return res.status(200).json({
      status: "success",
      message: "Shop details saved",
      data: { name: store.name, address: store.address, phone: store.phone, binNo: store.binNo, useVariants: store.useVariants, useSerials: store.useSerials, allowDue: store.allowDue, payMethodIds: shopMethodIds(store), shopType: store.shopType, district: store.district, thana: store.thana },
    });
  } catch (error) {
    logger.error(`Store update error: ${error.message}`);
    next(error);
  }
};

/* ---------------- SMS ---------------- */
/** Balance, which messages go out, templates (with the defaults) and whether the platform sends for real. */
exports.getSmsSettings = async (req, res, next) => {
  try {
    const [store, settings, sentMonth] = await Promise.all([
      prisma.store.findUnique({ where: { id: req.storeId }, select: { smsBalance: true, smsSettings: true } }),
      getPlatformSettings(),
      prisma.smsLog.aggregate({ where: { storeId: req.storeId, status: "sent", charged: true, createdAt: { gte: dayjs().startOf("month").toDate() } }, _sum: { parts: true } }),
    ]);
    return res.status(200).json({
      status: "success",
      data: {
        balance: store.smsBalance,
        usedThisMonth: sentMonth._sum.parts || 0,
        live: settings.smsLive && smsService.isConfigured(),
        settings: smsService.shopSmsSettings(store),
        defaults: smsService.TEMPLATES,
      },
    });
  } catch (error) {
    next(error);
  }
};

/** Body: { language, events: { sale, payment, daily_summary }, templates: { key: text | "" }, ownerPhone }. Empty template = default. */
exports.updateSmsSettings = async (req, res, next) => {
  try {
    const b = req.body;
    const store = await prisma.store.findUnique({ where: { id: req.storeId }, select: { smsSettings: true } });
    const cur = store.smsSettings && typeof store.smsSettings === "object" ? store.smsSettings : {};
    const next_ = { ...cur };
    if (b.language) next_.language = b.language === "bn" ? "bn" : "en";
    if (b.events) next_.events = { sale: !!b.events.sale, payment: !!b.events.payment, daily_summary: !!b.events.daily_summary };
    if (b.templates) {
      const t = {};
      smsService.EVENT_KEYS.forEach((k) => {
        const v = String(b.templates[k] || "").trim();
        if (v) {
          if (v.length > 480) throw apiError.badRequest("A message can be at most 480 characters");
          t[k] = v;
        }
      });
      next_.templates = t;
    }
    if (b.ownerPhone !== undefined) {
      if (b.ownerPhone && !smsService.bdNumber(b.ownerPhone)) throw apiError.badRequest("Enter a valid mobile number for the daily summary");
      next_.ownerPhone = b.ownerPhone ? String(b.ownerPhone).trim() : "";
    }
    if (next_.events?.daily_summary && !next_.ownerPhone) throw apiError.badRequest("Enter the owner's mobile number for the daily summary");
    await prisma.store.update({ where: { id: req.storeId }, data: { smsSettings: next_ } });
    return res.status(200).json({ status: "success", message: "SMS settings saved", data: null });
  } catch (error) {
    next(error);
  }
};

/** The last 300 SMS of this shop. */
exports.getSmsLog = async (req, res, next) => {
  try {
    const data = await prisma.smsLog.findMany({ where: { storeId: req.storeId }, orderBy: { createdAt: "desc" }, take: 300 });
    return res.status(200).json({ status: "success", data });
  } catch (error) {
    next(error);
  }
};

/** A test message to a number (default: the owner phone). Free, at most 5 a day. */
exports.sendTestSms = async (req, res, next) => {
  try {
    const store = await prisma.store.findUnique({ where: { id: req.storeId }, select: { name: true, smsSettings: true } });
    const to = req.body.to || smsService.shopSmsSettings(store).ownerPhone || req.user.phone;
    if (!smsService.bdNumber(to)) throw apiError.badRequest("Enter a valid mobile number");
    const today = await prisma.smsLog.count({ where: { storeId: req.storeId, type: "test", createdAt: { gte: dayjs().startOf("day").toDate() } } });
    if (today >= 5) throw apiError.badRequest("You can send 5 test messages a day");
    const log = await smsService.queueSms({ storeId: req.storeId, to, type: "test", message: `Test message from ${store.name}. SMS is working.`, createdById: req.user.id });
    return res.status(200).json({ status: "success", message: log.status === "queued" ? "Test message is on its way" : log.error, data: log });
  } catch (error) {
    next(error);
  }
};

/** Subscription payments this shop made (Settings → Plan & billing). */
exports.getBillingHistory = async (req, res, next) => {
  try {
    const data = await prisma.subscriptionPayment.findMany({
      where: { storeId: req.storeId },
      orderBy: [{ date: "desc" }, { createdAt: "desc" }],
      select: { id: true, date: true, amount: true, months: true, method: true, reference: true, periodFrom: true, periodTo: true, planName: true },
    });
    return res.status(200).json({ status: "success", data });
  } catch (error) {
    next(error);
  }
};

/* ---------------- roles ---------------- */
exports.createRole = async (req, res, next) => {
  try {
    const name = String(req.body.name || "").trim();
    if (!name) throw apiError.badRequest("Role name is required");
    const role = await prisma.role.create({
      data: { ...tenant(req), name, permissions: cleanPermissions(req.body.permissions) },
    });
    return res.status(201).json({ status: "success", message: "Role saved", data: role });
  } catch (error) {
    logger.error(`Role creation error: ${error.message}`);
    next(error);
  }
};

exports.updateRole = async (req, res, next) => {
  try {
    const role = await prisma.role.findFirst({ where: { id: req.params.id, storeId: req.storeId } });
    if (!role) throw apiError.notFound("Role not found");
    if (role.system) throw apiError.badRequest("Admin has every permission and cannot be edited.");
    const name = String(req.body.name ?? role.name).trim();
    if (!name) throw apiError.badRequest("Role name is required");
    const updated = await prisma.role.update({
      where: { id: role.id },
      data: { name, permissions: cleanPermissions(req.body.permissions ?? role.permissions) },
    });
    return res.status(200).json({ status: "success", message: "Role saved", data: updated });
  } catch (error) {
    logger.error(`Role update error: ${error.message}`);
    next(error);
  }
};

exports.deleteRole = async (req, res, next) => {
  try {
    const role = await prisma.role.findFirst({ where: { id: req.params.id, storeId: req.storeId } });
    if (!role) throw apiError.notFound("Role not found");
    if (role.system) throw apiError.badRequest("The Admin role can't be deleted");
    if (role.key === "sr") throw apiError.badRequest("The Sales Rep (SR) role is needed for SR logins and can't be deleted");
    const used = await prisma.user.count({ where: { roleId: role.id } });
    if (used) throw apiError.badRequest("Role is assigned to a user");
    await prisma.role.delete({ where: { id: role.id } });
    return res.status(200).json({ status: "success", message: "Role deleted", data: null });
  } catch (error) {
    logger.error(`Role delete error: ${error.message}`);
    next(error);
  }
};

/* ---------------- users ---------------- */
const userFields = async (req) => {
  const { name, email, phone, roleId } = req.body;
  const clean = {
    name: String(name || "").trim(),
    email: normEmail(email) || null,
    phone: phone ? String(phone).trim() : null,
  };
  clean.phoneKey = clean.phone ? normPhone(clean.phone) || null : null;
  if (!clean.name) throw apiError.badRequest("Name is required");
  if (!clean.email && !clean.phone) throw apiError.badRequest("Give an email or a phone number to log in with");
  const role = await prisma.role.findFirst({ where: { id: roleId || "", storeId: req.storeId } });
  if (!role) throw apiError.badRequest("Select a role");
  return clean;
};

/** New user (Settings → Users). */
exports.createUser = async (req, res, next) => {
  try {
    const clean = await userFields(req);
    await checkUnique(prisma, clean);
    checkPassword(req.body.password);
    if (req.body.status !== "inactive") await checkUserLimit(prisma, req.storeId);
    const user = await prisma.user.create({
      data: {
        ...tenant(req),
        ...clean,
        loginWith: clean.email ? "email" : "phone",
        roleId: req.body.roleId,
        status: req.body.status === "inactive" ? "inactive" : "active",
        password: await bcrypt.hash(String(req.body.password), 10),
      },
    });
    return res.status(201).json({ status: "success", message: `${user.name} can now log in`, data: safeUser(user) });
  } catch (error) {
    logger.error(`User creation error: ${error.message}`);
    next(error);
  }
};

/**
 * Edit a user. `password` is optional (sets a new one).
 * The signed-in user cannot deactivate themself or change their own role.
 */
exports.updateUser = async (req, res, next) => {
  try {
    const id = req.params.id;
    const u = await prisma.user.findFirst({ where: { id, storeId: req.storeId } });
    if (!u) throw apiError.notFound("User not found");
    const clean = await userFields(req);
    await checkUnique(prisma, clean, id);
    const status = req.body.status === "inactive" ? "inactive" : req.body.status === "active" ? "active" : u.status;
    if (id === req.user.id && (status === "inactive" || req.body.roleId !== u.roleId)) {
      throw apiError.badRequest("You cannot deactivate yourself or change your own role");
    }
    if (u.status !== "active" && status === "active") await checkUserLimit(prisma, req.storeId);
    const data = { ...clean, roleId: req.body.roleId, status };
    if (u.loginWith === "email" && !clean.email) data.loginWith = "phone";
    if (req.body.password) {
      checkPassword(req.body.password);
      data.password = await bcrypt.hash(String(req.body.password), 10);
      data.passwordChangedAt = dayjs().toISOString();
    }
    const user = await prisma.$transaction(async (tx) => {
      const saved = await tx.user.update({ where: { id }, data });
      // keep the linked SR's name and phone in step
      const linked = await tx.employee.findMany({ where: { storeId: req.storeId, userId: id } });
      for (const e of linked) {
        await tx.employee.update({ where: { id: e.id }, data: { name: saved.name, phone: saved.phone || e.phone } });
      }
      return saved;
    });
    return res.status(200).json({ status: "success", message: `${user.name} updated`, data: safeUser(user) });
  } catch (error) {
    logger.error(`User update error: ${error.message}`);
    next(error);
  }
};

/* ---------------- clear all data ---------------- */
/**
 * "Clear all data": every list the store filled in is emptied. Store, plan, roles, users and the
 * employee records behind logins stay.
 */
exports.clearData = async (req, res, next) => {
  try {
    const where = { storeId: req.storeId };
    await storeTransaction(req.storeId, async (tx) => {
      await tx.salesReturnDetails.deleteMany({ where });
      await tx.salesReturn.deleteMany({ where });
      await tx.customerPayment.deleteMany({ where });
      await tx.invoiceDetails.deleteMany({ where });
      await tx.salesInvoice.deleteMany({ where });
      await tx.salesOrderDetails.deleteMany({ where });
      await tx.salesOrder.deleteMany({ where });
      await tx.issueExpense.deleteMany({ where });
      await tx.productIssueDetails.deleteMany({ where });
      await tx.productIssue.deleteMany({ where });
      await tx.stockAdjustment.deleteMany({ where });
      await tx.discount.deleteMany({ where });
      await tx.supplierPayment.deleteMany({ where });
      await tx.stockDetails.deleteMany({ where });
      await tx.stockSummary.deleteMany({ where });
      await tx.stock.deleteMany({ where });
      await tx.product.deleteMany({ where });
      await tx.unit.deleteMany({ where });
      await tx.category.deleteMany({ where });
      await tx.brand.deleteMany({ where });
      await tx.supplier.deleteMany({ where });
      await tx.expense.deleteMany({ where });
      await tx.expenseCategory.deleteMany({ where });
      await tx.staffDue.deleteMany({ where });
      await tx.customer.deleteMany({ where });
      await tx.route.deleteMany({ where });
      await tx.area.deleteMany({ where });
      await tx.notification.deleteMany({ where });
      await tx.counter.deleteMany({ where });
      // SRs who log in are accounts, not data: keep their employee record so the login keeps working
      await tx.employee.deleteMany({ where: { ...where, userId: null } });
    });
    logger.info(`All data cleared for store ${req.storeCode} by ${req.user.id}`);
    return res.status(200).json({ status: "success", message: "All data has been cleared", data: null });
  } catch (error) {
    logger.error(`Clear data error: ${error.message}`);
    next(error);
  }
};

/* ---------------- notifications ---------------- */
exports.getNotifications = async (req, res, next) => {
  try {
    const [list, users] = await Promise.all([
      prisma.notification.findMany({ where: { storeId: req.storeId }, orderBy: { createdAt: "desc" }, take: 100 }),
      prisma.user.findMany({ where: { storeId: req.storeId }, select: { id: true, name: true } }),
    ]);
    const uName = (id) => users.find((u) => u.id === id)?.name || "—";
    return res.status(200).json({
      status: "success",
      data: list.map((n) => ({ ...n, userName: uName(n.userId) })),
    });
  } catch (error) {
    logger.error(`Notifications error: ${error.message}`);
    next(error);
  }
};

module.exports.checkUnique = checkUnique;
module.exports.checkPassword = checkPassword;
