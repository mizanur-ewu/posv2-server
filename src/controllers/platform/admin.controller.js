const dayjs = require("dayjs");
const bcrypt = require("bcryptjs");
const { logger } = require("../../utils/logger");
const { prisma } = require("../../config/db");
const apiError = require("../../utils/apiError");
const { r2, toDate, normEmail } = require("../../utils/helperFunction");
const { getPlatformSettings, clearSettingsCache, billingOf, audit, loginTaken } = require("../../utils/platform");
const { safePlatformUser } = require("../auth.controller");

/* ---------------- session ---------------- */
/** The signed-in platform person and the platform settings – the admin console shell. */
exports.getMe = async (req, res, next) => {
  try {
    const settings = await getPlatformSettings();
    return res.status(200).json({ status: "success", data: { platform: true, user: req.platformUser, settings } });
  } catch (error) {
    next(error);
  }
};

exports.changeMyPassword = async (req, res, next) => {
  try {
    const { currentPassword, newPassword } = req.body;
    if (String(newPassword || "").length < 6) throw apiError.badRequest("Password must be at least 6 characters");
    const pu = await prisma.platformUser.findUnique({ where: { id: req.platformUser.id } });
    if (!(await bcrypt.compare(String(currentPassword || ""), pu.password))) throw apiError.badRequest("Current password is wrong");
    await prisma.platformUser.update({ where: { id: pu.id }, data: { password: await bcrypt.hash(String(newPassword), 10), passwordChangedAt: dayjs().toISOString() } });
    return res.status(200).json({ status: "success", message: "Password changed successfully", data: null });
  } catch (error) {
    next(error);
  }
};

/* ---------------- overview ---------------- */
/** Counts, money and the shops that need attention. */
exports.getOverview = async (req, res, next) => {
  try {
    const now = dayjs();
    const monthStart = now.startOf("month");
    const [settings, stores, payments, monthSales, todaySales, users, signups] = await Promise.all([
      getPlatformSettings(),
      prisma.store.findMany({ include: { company: { select: { name: true } }, plan: { select: { name: true, priceMonthly: true } } } }),
      prisma.subscriptionPayment.findMany({ where: { date: { gte: toDate(now.subtract(11, "month").startOf("month")) } }, select: { amount: true, date: true } }),
      prisma.salesInvoice.groupBy({ by: ["storeId"], where: { soldDate: { gte: monthStart.toDate() } }, _sum: { totalAmount: true, returnedAmount: true }, _count: { _all: true } }),
      prisma.salesInvoice.aggregate({ where: { soldDate: { gte: now.startOf("day").toDate() } }, _sum: { totalAmount: true, returnedAmount: true }, _count: { _all: true } }),
      prisma.user.groupBy({ by: ["storeId"], where: { status: "active" }, _count: { _all: true }, _max: { lastLoginAt: true } }),
      prisma.store.count({ where: { createdAt: { gte: monthStart.toDate() } } }),
    ]);

    const U = new Map(users.map((u) => [u.storeId, u]));
    const S = new Map(monthSales.map((s) => [s.storeId, s]));
    const shops = stores.map((s) => {
      const b = billingOf(s, settings, now);
      const sale = S.get(s.id);
      return {
        id: s.id,
        name: s.name,
        code: s.code,
        companyName: s.company?.name,
        planName: s.plan?.name || null,
        priceMonthly: Number(s.plan?.priceMonthly || 0),
        billing: b,
        createdAt: s.createdAt,
        source: s.source,
        users: U.get(s.id)?._count._all || 0,
        lastActiveAt: U.get(s.id)?._max.lastLoginAt || null,
        salesMonth: sale ? r2(Number(sale._sum.totalAmount || 0) - Number(sale._sum.returnedAmount || 0)) : 0,
        invoicesMonth: sale?._count._all || 0,
      };
    });
    const count = (st) => shops.filter((s) => s.billing.state === st).length;
    const sum = (list, k) => r2(list.reduce((a, x) => a + (Number(x[k]) || 0), 0));
    const month = (d) => dayjs(d).format("YYYY-MM");

    const revenueByMonth = Array.from({ length: 12 }, (_, i) => {
      const m = now.subtract(11 - i, "month");
      return { month: m.format("YYYY-MM"), amount: sum(payments.filter((p) => month(p.date) === m.format("YYYY-MM")), "amount") };
    });

    const expiringSoon = shops
      .filter((s) => ["trial", "active"].includes(s.billing.state) && s.billing.daysLeft !== null && s.billing.daysLeft <= 7)
      .sort((a, b) => a.billing.daysLeft - b.billing.daysLeft);
    const ended = shops.filter((s) => ["grace", "expired"].includes(s.billing.state)).sort((a, b) => String(a.billing.endsAt).localeCompare(String(b.billing.endsAt)));

    return res.status(200).json({
      status: "success",
      data: {
        counts: {
          shops: shops.length,
          active: count("active"),
          trial: count("trial"),
          grace: count("grace"),
          expired: count("expired"),
          suspended: count("suspended"),
          newThisMonth: signups,
          users: sum(shops, "users"),
        },
        money: {
          mrr: sum(shops.filter((s) => s.billing.state === "active" && !s.billing.noEnd), "priceMonthly"),
          collectedThisMonth: sum(payments.filter((p) => month(p.date) === now.format("YYYY-MM")), "amount"),
          collectedLastMonth: sum(payments.filter((p) => month(p.date) === now.subtract(1, "month").format("YYYY-MM")), "amount"),
          revenueByMonth,
        },
        activity: {
          salesToday: r2(Number(todaySales._sum.totalAmount || 0) - Number(todaySales._sum.returnedAmount || 0)),
          invoicesToday: todaySales._count._all,
          salesMonth: sum(shops, "salesMonth"),
          invoicesMonth: sum(shops, "invoicesMonth"),
          activeShops7d: shops.filter((s) => s.lastActiveAt && now.diff(dayjs(s.lastActiveAt), "day") < 7).length,
        },
        expiringSoon,
        ended,
        newest: [...shops].sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt))).slice(0, 6),
        topShops: [...shops].filter((s) => s.salesMonth > 0).sort((a, b) => b.salesMonth - a.salesMonth).slice(0, 6),
        quiet: shops.filter((s) => s.billing.state !== "suspended" && (!s.lastActiveAt || now.diff(dayjs(s.lastActiveAt), "day") >= 14)).slice(0, 8),
      },
    });
  } catch (error) {
    logger.error(`Platform overview error: ${error.message}`);
    next(error);
  }
};

/* ---------------- announcements ---------------- */
const annFields = (b) => {
  const title = String(b.title || "").trim();
  const message = String(b.message || "").trim();
  if (!title) throw apiError.badRequest("Enter a title");
  if (!message) throw apiError.badRequest("Enter the message");
  return { title, message, level: b.level === "warning" ? "warning" : "info", active: b.active !== false, endDate: b.endDate ? toDate(b.endDate) : null };
};

exports.listAnnouncements = async (req, res, next) => {
  try {
    const data = await prisma.announcement.findMany({ orderBy: { createdAt: "desc" } });
    return res.status(200).json({ status: "success", data });
  } catch (error) {
    next(error);
  }
};

exports.createAnnouncement = async (req, res, next) => {
  try {
    const a = await prisma.announcement.create({ data: { ...annFields(req.body), createdById: req.platformUser.id } });
    await audit(req.platformUser, "announcement.create", { detail: a.title });
    return res.status(201).json({ status: "success", message: "Announcement saved. Every shop sees it now.", data: a });
  } catch (error) {
    next(error);
  }
};

exports.updateAnnouncement = async (req, res, next) => {
  try {
    const old = await prisma.announcement.findUnique({ where: { id: req.params.id } });
    if (!old) throw apiError.notFound("Announcement not found");
    const a = await prisma.announcement.update({ where: { id: old.id }, data: annFields({ ...old, ...req.body }) });
    await audit(req.platformUser, "announcement.update", { detail: a.title });
    return res.status(200).json({ status: "success", message: "Announcement saved", data: a });
  } catch (error) {
    next(error);
  }
};

exports.deleteAnnouncement = async (req, res, next) => {
  try {
    const a = await prisma.announcement.delete({ where: { id: req.params.id } });
    await audit(req.platformUser, "announcement.delete", { detail: a.title });
    return res.status(200).json({ status: "success", message: "Announcement deleted", data: null });
  } catch (error) {
    next(error);
  }
};

/* ---------------- team (platform people) ---------------- */
exports.listTeam = async (req, res, next) => {
  try {
    const list = await prisma.platformUser.findMany({ orderBy: { createdAt: "asc" } });
    return res.status(200).json({ status: "success", data: list.map(safePlatformUser) });
  } catch (error) {
    next(error);
  }
};

/** Create or edit a platform person. `password` is required on create, optional on edit. */
exports.saveTeamMember = async (req, res, next) => {
  try {
    const id = req.params.id;
    const b = req.body;
    const name = String(b.name || "").trim();
    const email = normEmail(b.email);
    if (!name) throw apiError.badRequest("Name is required");
    if (!email) throw apiError.badRequest("Email is required");
    const taken = await loginTaken(prisma, { email }, { exceptPlatformId: id });
    if (taken) throw apiError.conflict(taken);
    const role = b.role === "owner" ? "owner" : "support";
    const status = b.status === "inactive" ? "inactive" : "active";
    const data = { name, email, phone: b.phone ? String(b.phone).trim() : null, role, status };

    if (id) {
      const old = await prisma.platformUser.findUnique({ where: { id } });
      if (!old) throw apiError.notFound("Not found");
      if (id === req.platformUser.id && (role !== "owner" || status !== "active")) throw apiError.badRequest("You cannot remove your own owner access");
      if (old.role === "owner" && (role !== "owner" || status !== "active")) {
        const owners = await prisma.platformUser.count({ where: { role: "owner", status: "active" } });
        if (owners <= 1) throw apiError.badRequest("The platform needs at least one active owner");
      }
      if (b.password) {
        if (String(b.password).length < 6) throw apiError.badRequest("Password must be at least 6 characters");
        data.password = await bcrypt.hash(String(b.password), 10);
        data.passwordChangedAt = dayjs().toISOString();
      }
      const saved = await prisma.platformUser.update({ where: { id }, data });
      await audit(req.platformUser, "team.update", { detail: `${saved.name} (${saved.role}, ${saved.status})` });
      return res.status(200).json({ status: "success", message: `${saved.name} updated`, data: safePlatformUser(saved) });
    }
    if (String(b.password || "").length < 6) throw apiError.badRequest("Password must be at least 6 characters");
    const saved = await prisma.platformUser.create({ data: { ...data, password: await bcrypt.hash(String(b.password), 10) } });
    await audit(req.platformUser, "team.create", { detail: `${saved.name} (${saved.role})` });
    return res.status(201).json({ status: "success", message: `${saved.name} can now sign in`, data: safePlatformUser(saved) });
  } catch (error) {
    next(error);
  }
};

/* ---------------- activity log ---------------- */
exports.listAudit = async (req, res, next) => {
  try {
    const where = {};
    if (req.query.storeId) where.storeId = req.query.storeId;
    if (req.query.action) where.action = { startsWith: String(req.query.action) };
    const data = await prisma.platformAudit.findMany({ where, orderBy: { createdAt: "desc" }, take: 1000 });
    return res.status(200).json({ status: "success", data });
  } catch (error) {
    next(error);
  }
};

/* ---------------- platform settings ---------------- */
exports.getSettings = async (req, res, next) => {
  try {
    return res.status(200).json({ status: "success", data: await getPlatformSettings(true) });
  } catch (error) {
    next(error);
  }
};

exports.updateSettings = async (req, res, next) => {
  try {
    const b = req.body;
    const brandName = String(b.brandName || "").trim();
    if (!brandName) throw apiError.badRequest("Enter the app name");
    const int = (v, min, max, d) => Math.min(max, Math.max(min, parseInt(v, 10) || d));
    if (b.signupPlanId && !(await prisma.plan.findUnique({ where: { id: b.signupPlanId } }))) throw apiError.badRequest("Select a plan");
    const data = {
      brandName,
      supportPhone: b.supportPhone ? String(b.supportPhone).trim() : null,
      supportEmail: b.supportEmail ? String(b.supportEmail).trim() : null,
      paymentInfo: b.paymentInfo ? String(b.paymentInfo).trim() : null,
      trialDays: int(b.trialDays, 1, 365, 14),
      graceDays: int(b.graceDays, 0, 90, 7),
      signupEnabled: !!b.signupEnabled,
      signupPlanId: b.signupPlanId || null,
    };
    const saved = await prisma.platformSetting.upsert({ where: { id: "default" }, create: { id: "default", ...data }, update: data });
    clearSettingsCache();
    await audit(req.platformUser, "settings.update");
    return res.status(200).json({ status: "success", message: "Settings saved", data: saved });
  } catch (error) {
    next(error);
  }
};
