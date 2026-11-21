const dayjs = require("dayjs");
const { logger } = require("../../utils/logger");
const { prisma } = require("../../config/db");
const apiError = require("../../utils/apiError");
const { r2, toDate } = require("../../utils/helperFunction");
const { audit } = require("../../utils/platform");

/* ---------------- plans ---------------- */
const planFields = (b) => {
  const name = String(b.name || "").trim();
  if (!name) throw apiError.badRequest("Enter the plan name");
  if (!["pos", "dealer", "both"].includes(b.modules)) throw apiError.badRequest("Select the modules");
  const maxUsers = b.maxUsers === null || b.maxUsers === "" || b.maxUsers === undefined ? null : Math.max(1, parseInt(b.maxUsers, 10) || 1);
  return {
    name,
    description: b.description ? String(b.description).trim() : null,
    modules: b.modules,
    priceMonthly: r2(b.priceMonthly),
    priceYearly: r2(b.priceYearly),
    maxUsers,
    sortOrder: parseInt(b.sortOrder, 10) || 0,
    active: b.active !== false,
  };
};

/** Plans with how many shops use each. */
exports.listPlans = async (req, res, next) => {
  try {
    const [plans, counts] = await Promise.all([
      prisma.plan.findMany({ orderBy: [{ sortOrder: "asc" }, { createdAt: "asc" }] }),
      prisma.store.groupBy({ by: ["planId"], _count: { _all: true } }),
    ]);
    const used = new Map(counts.map((c) => [c.planId, c._count._all]));
    return res.status(200).json({ status: "success", data: plans.map((p) => ({ ...p, shops: used.get(p.id) || 0 })) });
  } catch (error) {
    next(error);
  }
};

exports.createPlan = async (req, res, next) => {
  try {
    const plan = await prisma.plan.create({ data: planFields(req.body) });
    await audit(req.platformUser, "plan.create", { detail: plan.name });
    return res.status(201).json({ status: "success", message: "Plan saved", data: plan });
  } catch (error) {
    next(error);
  }
};

/** Edit a plan. Changing its modules also changes the modules of every shop on it. */
exports.updatePlan = async (req, res, next) => {
  try {
    const old = await prisma.plan.findUnique({ where: { id: req.params.id } });
    if (!old) throw apiError.notFound("Plan not found");
    const data = planFields({ ...old, ...req.body });
    const plan = await prisma.$transaction(async (tx) => {
      const saved = await tx.plan.update({ where: { id: old.id }, data });
      if (saved.modules !== old.modules) await tx.store.updateMany({ where: { planId: old.id }, data: { subscription: saved.modules } });
      return saved;
    });
    await audit(req.platformUser, "plan.update", { detail: plan.name });
    return res.status(200).json({ status: "success", message: "Plan saved", data: plan });
  } catch (error) {
    next(error);
  }
};

exports.deletePlan = async (req, res, next) => {
  try {
    const plan = await prisma.plan.findUnique({ where: { id: req.params.id } });
    if (!plan) throw apiError.notFound("Plan not found");
    const used = await prisma.store.count({ where: { planId: plan.id } });
    if (used) throw apiError.badRequest(`${used} shop(s) use this plan. Move them to another plan, or switch this plan off instead.`);
    await prisma.plan.delete({ where: { id: plan.id } });
    await audit(req.platformUser, "plan.delete", { detail: plan.name });
    return res.status(200).json({ status: "success", message: "Plan deleted", data: null });
  } catch (error) {
    next(error);
  }
};

/* ---------------- subscription payments ---------------- */
/** Every payment, newest first, with the shop's name. ?storeId= ?from= ?to= */
exports.listPayments = async (req, res, next) => {
  try {
    const where = {};
    if (req.query.storeId) where.storeId = req.query.storeId;
    if (req.query.from || req.query.to) {
      where.date = {};
      if (req.query.from) where.date.gte = toDate(req.query.from);
      if (req.query.to) where.date.lte = toDate(req.query.to);
    }
    const [payments, stores, people] = await Promise.all([
      prisma.subscriptionPayment.findMany({ where, orderBy: [{ date: "desc" }, { createdAt: "desc" }], take: 2000 }),
      prisma.store.findMany({ select: { id: true, name: true, code: true } }),
      prisma.platformUser.findMany({ select: { id: true, name: true } }),
    ]);
    const S = new Map(stores.map((s) => [s.id, s]));
    const P = new Map(people.map((p) => [p.id, p.name]));
    const data = payments.map((p) => ({ ...p, shopName: S.get(p.storeId)?.name || "—", shopCode: S.get(p.storeId)?.code || "", recordedBy: P.get(p.createdById) || "—" }));
    return res.status(200).json({ status: "success", data });
  } catch (error) {
    next(error);
  }
};

/**
 * Record a payment for a shop. It covers `months` months starting the day after the shop's
 * current paid-until date (or today when that has passed) and moves paid-until to the end.
 * Body: { storeId, amount, months, method, reference, date, planId?, note }
 */
exports.recordPayment = async (req, res, next) => {
  try {
    const b = req.body;
    const store = await prisma.store.findUnique({ where: { id: b.storeId || "" } });
    if (!store) throw apiError.badRequest("Select the shop");
    const amount = r2(b.amount);
    if (!(amount >= 0)) throw apiError.badRequest("Enter the amount");
    const months = parseInt(b.months, 10);
    if (!(months >= 1 && months <= 60)) throw apiError.badRequest("Months must be between 1 and 60");
    if (!String(b.method || "").trim()) throw apiError.badRequest("Select how they paid");

    let plan = null;
    if (b.planId) {
      plan = await prisma.plan.findUnique({ where: { id: b.planId } });
      if (!plan) throw apiError.badRequest("Select a plan");
    } else if (store.planId) plan = await prisma.plan.findUnique({ where: { id: store.planId } });

    const today = dayjs().startOf("day");
    const from = store.paidUntil && dayjs(store.paidUntil).isAfter(today.subtract(1, "day")) ? dayjs(store.paidUntil).add(1, "day") : today;
    const to = from.add(months, "month").subtract(1, "day");

    const payment = await prisma.$transaction(async (tx) => {
      const p = await tx.subscriptionPayment.create({
        data: {
          storeId: store.id,
          planId: plan?.id || null,
          planName: plan?.name || null,
          amount,
          months,
          method: String(b.method).trim(),
          reference: b.reference ? String(b.reference).trim() : null,
          date: toDate(b.date || today),
          periodFrom: toDate(from),
          periodTo: toDate(to),
          note: b.note ? String(b.note).trim() : null,
          createdById: req.platformUser.id,
        },
      });
      await tx.store.update({
        where: { id: store.id },
        data: { paidUntil: toDate(to), ...(plan && b.planId ? { planId: plan.id, subscription: plan.modules } : {}) },
      });
      return p;
    });
    await audit(req.platformUser, "payment.record", { store, detail: `৳${amount} · ${months} month(s) · ${payment.method} · until ${to.format("YYYY-MM-DD")}` });
    return res.status(201).json({ status: "success", message: `Payment saved. ${store.name} is paid until ${to.format("DD MMM YYYY")}.`, data: payment });
  } catch (error) {
    logger.error(`Record payment error: ${error.message}`);
    next(error);
  }
};

/** Remove a payment typed by mistake. The shop's paid-until date is not changed. */
exports.deletePayment = async (req, res, next) => {
  try {
    const p = await prisma.subscriptionPayment.findUnique({ where: { id: req.params.id } });
    if (!p) throw apiError.notFound("Payment not found");
    const store = await prisma.store.findUnique({ where: { id: p.storeId } });
    await prisma.subscriptionPayment.delete({ where: { id: p.id } });
    await audit(req.platformUser, "payment.delete", { store, detail: `৳${p.amount} on ${p.date}` });
    return res.status(200).json({ status: "success", message: "Payment removed. Check the shop's paid-until date.", data: null });
  } catch (error) {
    next(error);
  }
};
