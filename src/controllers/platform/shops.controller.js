const dayjs = require("dayjs");
const bcrypt = require("bcryptjs");
const { logger } = require("../../utils/logger");
const { prisma } = require("../../config/db");
const apiError = require("../../utils/apiError");
const { r2, toDate, normEmail, normPhone } = require("../../utils/helperFunction");
const { safeUser } = require("../../utils/viewHelper");
const { getPlatformSettings, billingOf, audit, createShop, loginTaken } = require("../../utils/platform");
const { signShopToken } = require("../auth.controller");
const { isShopType, cleanText } = require("../../utils/shopTypes");

const STORE_INCLUDE = { company: { select: { name: true } }, plan: { select: { id: true, name: true, priceMonthly: true, priceYearly: true, maxUsers: true, modules: true } } };

/** Users of many shops → per shop: owner (first active Admin), active user count, last sign-in. */
const userStats = (users) => {
  const m = new Map();
  users.forEach((u) => {
    const s = m.get(u.storeId) || { users: 0, lastActiveAt: null, owner: null };
    if (u.status === "active") s.users += 1;
    if (u.lastLoginAt && (!s.lastActiveAt || u.lastLoginAt > s.lastActiveAt)) s.lastActiveAt = u.lastLoginAt;
    if (u.role?.system && !s.owner && u.status === "active") s.owner = { id: u.id, name: u.name, email: u.email, phone: u.phone, lastLoginAt: u.lastLoginAt };
    m.set(u.storeId, s);
  });
  return m;
};

/** Sales (after returns) and invoice count per shop since `from`. */
const salesSince = async (from, storeIds) => {
  const rows = await prisma.salesInvoice.groupBy({
    by: ["storeId"],
    where: { soldDate: { gte: from.toDate() }, ...(storeIds ? { storeId: { in: storeIds } } : {}) },
    _sum: { totalAmount: true, returnedAmount: true },
    _count: { _all: true },
  });
  return new Map(rows.map((r) => [r.storeId, { sales: r2(Number(r._sum.totalAmount || 0) - Number(r._sum.returnedAmount || 0)), invoices: r._count._all }]));
};

const shopRow = (store, settings, stats, sales) => ({
  id: store.id,
  code: store.code,
  name: store.name,
  companyId: store.companyId,
  companyName: store.company?.name,
  modules: store.subscription,
  status: store.status,
  suspendReason: store.suspendReason,
  plan: store.plan ? { ...store.plan, priceMonthly: Number(store.plan.priceMonthly), priceYearly: Number(store.plan.priceYearly) } : null,
  billing: billingOf(store, settings),
  trialEndsAt: store.trialEndsAt,
  paidUntil: store.paidUntil,
  address: store.address,
  phone: store.phone,
  shopType: store.shopType,
  district: store.district,
  thana: store.thana,
  setupPending: store.setupPending,
  notes: store.notes,
  source: store.source,
  smsBalance: store.smsBalance,
  useVariants: store.useVariants,
  useSerials: store.useSerials,
  createdAt: store.createdAt,
  owner: stats?.owner || null,
  users: stats?.users || 0,
  lastActiveAt: stats?.lastActiveAt || null,
  salesMonth: sales?.sales || 0,
  invoicesMonth: sales?.invoices || 0,
});

const loadShop = async (id) => {
  const store = await prisma.store.findUnique({ where: { id }, include: STORE_INCLUDE });
  if (!store) throw apiError.notFound("Shop not found");
  return store;
};

/** Every shop with its plan, billing state, owner, users and this month's sales. */
exports.listShops = async (req, res, next) => {
  try {
    const [settings, stores, users, sales] = await Promise.all([
      getPlatformSettings(),
      prisma.store.findMany({ include: STORE_INCLUDE, orderBy: { createdAt: "desc" } }),
      prisma.user.findMany({ select: { id: true, storeId: true, name: true, email: true, phone: true, status: true, lastLoginAt: true, role: { select: { system: true } } }, orderBy: { createdAt: "asc" } }),
      salesSince(dayjs().startOf("month")),
    ]);
    const stats = userStats(users);
    const data = stores.map((s) => shopRow(s, settings, stats.get(s.id), sales.get(s.id)));
    return res.status(200).json({ status: "success", data });
  } catch (error) {
    logger.error(`Platform shops error: ${error.message}`);
    next(error);
  }
};

/** One shop: details, users, payments, usage and its activity log. */
exports.getShop = async (req, res, next) => {
  try {
    const store = await loadShop(req.params.id);
    const where = { storeId: store.id };
    const today = dayjs().startOf("day");
    const [settings, users, payments, logs, salesMonth, salesToday, counts] = await Promise.all([
      getPlatformSettings(),
      prisma.user.findMany({ where, include: { role: { select: { name: true, system: true, key: true } } }, orderBy: { createdAt: "asc" } }),
      prisma.subscriptionPayment.findMany({ where, orderBy: [{ date: "desc" }, { createdAt: "desc" }] }),
      prisma.platformAudit.findMany({ where, orderBy: { createdAt: "desc" }, take: 50 }),
      salesSince(dayjs().startOf("month"), [store.id]),
      salesSince(today, [store.id]),
      Promise.all([
        prisma.product.count({ where }),
        prisma.customer.count({ where }),
        prisma.supplier.count({ where }),
        prisma.salesInvoice.count({ where }),
        prisma.stock.count({ where }),
        prisma.employee.count({ where }),
      ]),
    ]);
    const stats = userStats(users.map((u) => ({ ...u, role: u.role })));
    const row = shopRow(store, settings, stats.get(store.id), salesMonth.get(store.id));
    const [products, customers, suppliers, invoices, stockEntries, employees] = counts;
    return res.status(200).json({
      status: "success",
      data: {
        ...row,
        salesToday: salesToday.get(store.id)?.sales || 0,
        invoicesToday: salesToday.get(store.id)?.invoices || 0,
        usage: { products, customers, suppliers, invoices, stockEntries, employees },
        userList: users.map((u) => ({ ...safeUser(u), roleName: u.role?.name, isAdmin: !!u.role?.system })),
        payments,
        logs,
      },
    });
  } catch (error) {
    logger.error(`Platform shop error: ${error.message}`);
    next(error);
  }
};

/** Start dates for a new shop: { mode: 'trial' | 'paid' | 'none', trialDays, paidUntil }. */
const startDates = (b, settings) => {
  if (b?.mode === "none") return {};
  if (b?.mode === "paid") {
    if (!b.paidUntil) throw apiError.badRequest("Pick the date the shop is paid until");
    return { paidUntil: b.paidUntil };
  }
  const days = Number(b?.trialDays ?? settings.trialDays) || settings.trialDays;
  return { trialEndsAt: dayjs().add(days, "day") };
};

/**
 * New shop with its owner login.
 * Body: { businessName, shopName, code, modules, planId, address, phone, shopType, district, thana, notes, billing: {mode, trialDays, paidUntil}, owner: {name, email, phone, password} }
 */
exports.createShop = async (req, res, next) => {
  try {
    const settings = await getPlatformSettings();
    const b = req.body;
    const { store, user } = await prisma.$transaction((tx) =>
      createShop(tx, {
        businessName: b.businessName,
        shopName: b.shopName,
        code: b.code,
        modules: b.modules,
        planId: b.planId,
        address: b.address,
        phone: b.phone,
        shopType: b.shopType,
        district: b.district,
        thana: b.thana,
        source: "admin",
        smsBalance: settings.smsFreeCredits,
        ...startDates(b.billing, settings),
        owner: b.owner,
      }),
    );
    if (b.notes) await prisma.store.update({ where: { id: store.id }, data: { notes: b.notes } });
    await audit(req.platformUser, "shop.create", { store, detail: `Owner ${user.name} (${user.email || user.phone})` });
    return res.status(201).json({ status: "success", message: `${store.name} is ready. ${user.name} can sign in now.`, data: { id: store.id, code: store.code } });
  } catch (error) {
    logger.error(`Platform create shop error: ${error.message}`);
    next(error);
  }
};

/** Edit name, business name, contact, notes, plan and modules. */
exports.updateShop = async (req, res, next) => {
  try {
    const store = await loadShop(req.params.id);
    const b = req.body;
    const data = {};
    if (b.name !== undefined) {
      if (!String(b.name).trim()) throw apiError.badRequest("Enter the shop name");
      data.name = String(b.name).trim();
    }
    ["address", "phone", "notes"].forEach((k) => {
      if (b[k] !== undefined) data[k] = b[k] ? String(b[k]).trim() : null;
    });
    if (b.shopType !== undefined) {
      if (!isShopType(b.shopType)) throw apiError.badRequest("Select the shop category");
      data.shopType = b.shopType;
    }
    ["district", "thana"].forEach((k) => {
      if (b[k] !== undefined) data[k] = cleanText(b[k]);
    });
    if (b.planId !== undefined) {
      if (b.planId) {
        const plan = await prisma.plan.findUnique({ where: { id: b.planId } });
        if (!plan) throw apiError.badRequest("Select a plan");
        data.planId = plan.id;
        data.subscription = plan.modules;
      } else data.planId = null;
    }
    if (b.modules !== undefined) {
      if (!["pos", "dealer", "both"].includes(b.modules)) throw apiError.badRequest("Select the modules");
      data.subscription = b.modules;
    }
    await prisma.$transaction(async (tx) => {
      await tx.store.update({ where: { id: store.id }, data });
      if (b.companyName !== undefined && String(b.companyName).trim()) {
        await tx.company.update({ where: { id: store.companyId }, data: { name: String(b.companyName).trim() } });
      }
    });
    const changes = Object.keys(data).concat(b.companyName ? ["companyName"] : []).join(", ");
    await audit(req.platformUser, "shop.update", { store, detail: changes });
    return res.status(200).json({ status: "success", message: "Shop updated", data: null });
  } catch (error) {
    logger.error(`Platform update shop error: ${error.message}`);
    next(error);
  }
};

/** Set the trial end and / or paid-until date directly. Empty = remove that date. */
exports.setDates = async (req, res, next) => {
  try {
    const store = await loadShop(req.params.id);
    const data = {};
    if (req.body.trialEndsAt !== undefined) data.trialEndsAt = req.body.trialEndsAt ? toDate(req.body.trialEndsAt) : null;
    if (req.body.paidUntil !== undefined) data.paidUntil = req.body.paidUntil ? toDate(req.body.paidUntil) : null;
    await prisma.store.update({ where: { id: store.id }, data });
    await audit(req.platformUser, "shop.dates", {
      store,
      detail: `Trial ends ${req.body.trialEndsAt ?? store.trialEndsAt ?? "—"}, paid until ${req.body.paidUntil ?? store.paidUntil ?? "—"}`,
    });
    return res.status(200).json({ status: "success", message: "Subscription dates saved", data: null });
  } catch (error) {
    logger.error(`Platform set dates error: ${error.message}`);
    next(error);
  }
};

exports.suspendShop = async (req, res, next) => {
  try {
    const store = await loadShop(req.params.id);
    const reason = String(req.body.reason || "").trim() || null;
    await prisma.store.update({ where: { id: store.id }, data: { status: "suspended", suspendReason: reason } });
    await audit(req.platformUser, "shop.suspend", { store, detail: reason });
    return res.status(200).json({ status: "success", message: `${store.name} is suspended. Its users can't sign in.`, data: null });
  } catch (error) {
    next(error);
  }
};

exports.activateShop = async (req, res, next) => {
  try {
    const store = await loadShop(req.params.id);
    await prisma.store.update({ where: { id: store.id }, data: { status: "active", suspendReason: null } });
    await audit(req.platformUser, "shop.activate", { store });
    return res.status(200).json({ status: "success", message: `${store.name} is active again`, data: null });
  } catch (error) {
    next(error);
  }
};

/**
 * Open the shop as its admin: a 4-hour shop token marked with who opened it.
 * Works for suspended and expired shops too, so support can look and fix.
 */
exports.openShop = async (req, res, next) => {
  try {
    const store = await loadShop(req.params.id);
    const admin = await prisma.user.findFirst({
      where: { storeId: store.id, role: { system: true } },
      orderBy: [{ status: "asc" }, { createdAt: "asc" }],
    });
    if (!admin) throw apiError.badRequest("This shop has no admin user to open it with");
    const token = signShopToken(admin, { imp: req.platformUser.id, impName: req.platformUser.name }, "4h");
    await audit(req.platformUser, "shop.open", { store, detail: `As ${admin.name}` });
    return res.status(200).json({ status: "success", message: `Opened ${store.name}`, data: { accessToken: token, shop: { id: store.id, name: store.name, code: store.code } } });
  } catch (error) {
    logger.error(`Platform open shop error: ${error.message}`);
    next(error);
  }
};

/** Give a shop user a new password (e.g. the owner forgot it). */
exports.resetUserPassword = async (req, res, next) => {
  try {
    const store = await loadShop(req.params.id);
    const user = await prisma.user.findFirst({ where: { id: req.params.userId, storeId: store.id } });
    if (!user) throw apiError.notFound("User not found");
    if (String(req.body.password || "").length < 6) throw apiError.badRequest("Password must be at least 6 characters");
    await prisma.user.update({
      where: { id: user.id },
      data: { password: await bcrypt.hash(String(req.body.password), 10), passwordChangedAt: dayjs().toISOString() },
    });
    await audit(req.platformUser, "user.password", { store, detail: user.name });
    return res.status(200).json({ status: "success", message: `New password set for ${user.name}`, data: null });
  } catch (error) {
    next(error);
  }
};

/** Change a shop user's login (email / phone) or activate / deactivate them. */
exports.updateShopUser = async (req, res, next) => {
  try {
    const store = await loadShop(req.params.id);
    const user = await prisma.user.findFirst({ where: { id: req.params.userId, storeId: store.id } });
    if (!user) throw apiError.notFound("User not found");
    const data = {};
    if (req.body.status) data.status = req.body.status === "inactive" ? "inactive" : "active";
    if (req.body.email !== undefined || req.body.phone !== undefined) {
      const email = req.body.email !== undefined ? normEmail(req.body.email) || null : user.email;
      const phone = req.body.phone !== undefined ? (req.body.phone ? String(req.body.phone).trim() : null) : user.phone;
      if (!email && !phone) throw apiError.badRequest("Give an email or a phone number to log in with");
      const taken = await loginTaken(prisma, { email, phone }, { exceptUserId: user.id });
      if (taken) throw apiError.conflict(taken);
      Object.assign(data, { email, phone, phoneKey: phone ? normPhone(phone) || null : null, loginWith: email ? user.loginWith : "phone" });
    }
    await prisma.user.update({ where: { id: user.id }, data });
    await audit(req.platformUser, "user.update", { store, detail: `${user.name}: ${Object.keys(data).join(", ")}` });
    return res.status(200).json({ status: "success", message: `${user.name} updated`, data: null });
  } catch (error) {
    next(error);
  }
};

/** Everything a shop owns, children first (some links are RESTRICT). */
const deleteShopData = async (tx, storeId) => {
  const where = { storeId };
  const models = [
    "salesReturnDetails", "salesReturn", "customerPayment", "invoiceDetails", "salesInvoice", "salesOrderDetails", "salesOrder",
    "issueExpense", "productIssueDetails", "productIssue", "stockAdjustment", "discount", "supplierPayment", "stockDetails",
    "stockSummary", "stock", "product", "unit", "category", "brand", "supplier", "expense", "expenseCategory", "staffDue",
    "customer", "route", "area", "notification", "counter", "serialNumber", "warrantyClaim", "cashClosing", "smsLog", "employee", "user", "role", "subscriptionPayment",
  ];
  for (const m of models) await tx[m].deleteMany({ where });
};

/** Delete a shop and all its data for good. Body: { confirm: "<shop code>" }. Platform owner only. */
exports.deleteShop = async (req, res, next) => {
  try {
    const store = await loadShop(req.params.id);
    if (String(req.body?.confirm || "").trim().toUpperCase() !== store.code) {
      throw apiError.badRequest(`Type the shop code ${store.code} to confirm`);
    }
    await prisma.$transaction(
      async (tx) => {
        await deleteShopData(tx, store.id);
        await tx.store.delete({ where: { id: store.id } });
        if (!(await tx.store.count({ where: { companyId: store.companyId } }))) await tx.company.delete({ where: { id: store.companyId } });
      },
      { timeout: 120000, maxWait: 20000 },
    );
    await audit(req.platformUser, "shop.delete", { store });
    logger.info(`Shop ${store.code} deleted by platform user ${req.platformUser.id}`);
    return res.status(200).json({ status: "success", message: `${store.name} and all its data were deleted`, data: null });
  } catch (error) {
    logger.error(`Platform delete shop error: ${error.message}`);
    next(error);
  }
};
