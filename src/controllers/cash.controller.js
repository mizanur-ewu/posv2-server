const dayjs = require("dayjs");
const { logger } = require("../utils/logger");
const { prisma } = require("../config/db");
const apiError = require("../utils/apiError");
const { r2, toDate, tenant } = require("../utils/helperFunction");
const { roleCan } = require("../utils/permissions");
const { CASH } = require("../utils/stock/constants");
const { moneyMoves, balanceBefore } = require("../utils/money");

const NOTES = [1000, 500, 200, 100, 50, 20, 10, 5, 2, 1];
const dayOf = (v) => {
  const d = dayjs(v || undefined);
  if (!d.isValid()) throw apiError.badRequest("Invalid date");
  if (d.isAfter(dayjs(), "day")) throw apiError.badRequest("You can't close a day in the future");
  return d.format("YYYY-MM-DD");
};
/** Managers (cashClosing:view) see and close any drawer; everyone else only their own. */
const canSeeAll = (req) => roleCan(req.role, req.subscription, "cashClosing", "view");
const whose = (req, userId) => {
  const id = userId || req.user.id;
  if (id !== req.user.id && !canSeeAll(req)) throw apiError.forbidden("You can only close your own cash");
  return id;
};

/**
 * What the drawer should hold at the end of `date` for `userId`:
 * opening (last closing's cash kept in the drawer) + cash in − cash out, with every line it came from,
 * the non-cash money of the day and the day's sales by this user.
 */
const buildDay = async (storeId, userId, date) => {
  const [lines, last, sales, user] = await Promise.all([
    moneyMoves(prisma, storeId, { from: date, to: date, userId }),
    prisma.cashClosing.findFirst({ where: { storeId, userId, date: { lt: toDate(date) } }, orderBy: { date: "desc" } }),
    prisma.salesInvoice.aggregate({
      where: { storeId, soldById: userId, soldDate: { gte: dayjs(date).startOf("day").toDate(), lte: dayjs(date).endOf("day").toDate() } },
      _sum: { totalAmount: true, returnedAmount: true, totalDue: true },
      _count: { _all: true },
    }),
    prisma.user.findFirst({ where: { id: userId, storeId }, select: { id: true, name: true } }),
  ]);
  if (!user) throw apiError.notFound("User not found");
  const cashLines = lines.filter((l) => l.methodId === CASH);
  const nonCash = {};
  lines
    .filter((l) => l.methodId !== CASH)
    .forEach((l) => {
      nonCash[l.methodId] ||= { methodId: l.methodId, method: l.method, in: 0, out: 0 };
      nonCash[l.methodId].in = r2(nonCash[l.methodId].in + l.in);
      nonCash[l.methodId].out = r2(nonCash[l.methodId].out + l.out);
    });
  const cashIn = r2(cashLines.reduce((a, l) => a + l.in, 0));
  const cashOut = r2(cashLines.reduce((a, l) => a + l.out, 0));
  const openingCash = last ? r2(last.closingCash) : 0;
  return {
    date,
    user,
    lastClosing: last ? { date: last.date, closingCash: last.closingCash } : null,
    openingCash,
    cashIn,
    cashOut,
    expectedCash: r2(openingCash + cashIn - cashOut),
    lines: cashLines,
    nonCash: Object.values(nonCash),
    sales: {
      invoices: sales._count._all,
      amount: r2(Number(sales._sum.totalAmount || 0) - Number(sales._sum.returnedAmount || 0)),
      due: r2(sales._sum.totalDue || 0),
    },
  };
};

/** GET /cash/closing/day?date=&userId= → the saved closing, or the draft to count against. */
exports.getDay = async (req, res, next) => {
  try {
    const date = dayOf(req.query.date);
    const userId = whose(req, req.query.userId);
    const saved = await prisma.cashClosing.findUnique({ where: { storeId_userId_date: { storeId: req.storeId, userId, date: toDate(date) } } });
    const draft = await buildDay(req.storeId, userId, date);
    return res.status(200).json({ status: "success", data: { ...draft, closing: saved, notes: NOTES } });
  } catch (error) {
    logger.error(`Cash day error: ${error.message}`);
    next(error);
  }
};

/**
 * Close the day. Body: { date, userId?, openingCash?, denominations: { "1000": n, … } | countedCash, handedOver, note }.
 * The money in / out is worked out again here; the client only sends what was counted.
 */
exports.closeDay = async (req, res, next) => {
  try {
    const b = req.body;
    const date = dayOf(b.date);
    const userId = whose(req, b.userId);
    const exists = await prisma.cashClosing.findUnique({ where: { storeId_userId_date: { storeId: req.storeId, userId, date: toDate(date) } } });
    if (exists) throw apiError.conflict("This day is already closed. Reopen it first to close it again.");
    const day = await buildDay(req.storeId, userId, date);

    const denominations = {};
    let counted = 0;
    if (b.denominations && typeof b.denominations === "object") {
      NOTES.forEach((n) => {
        const c = Math.max(0, parseInt(b.denominations[n], 10) || 0);
        if (c) denominations[n] = c;
        counted += n * c;
      });
    }
    const coins = r2(b.coins);
    if (coins > 0) {
      denominations.other = coins;
      counted += coins;
    }
    if (!Object.keys(denominations).length) counted = r2(b.countedCash);
    if (!(counted >= 0)) throw apiError.badRequest("Enter the cash you counted");

    // opening can be corrected when there was no earlier closing (first day) – after that it follows the last closing
    const openingCash = day.lastClosing ? day.openingCash : r2(b.openingCash ?? 0);
    const expectedCash = r2(openingCash + day.cashIn - day.cashOut);
    const handedOver = r2(b.handedOver);
    if (handedOver < 0 || handedOver > counted + 0.001) throw apiError.badRequest("Handed over can't be more than the cash counted");

    const closing = await prisma.cashClosing.create({
      data: {
        ...tenant(req),
        userId,
        date: toDate(date),
        openingCash,
        cashIn: day.cashIn,
        cashOut: day.cashOut,
        expectedCash,
        countedCash: r2(counted),
        difference: r2(counted - expectedCash),
        handedOver,
        closingCash: r2(counted - handedOver),
        lines: day.lines.map(({ id, at, kind, label, ref, party, in: i, out }) => ({ id, at, kind, label, ref, party, in: i, out })),
        nonCash: day.nonCash,
        denominations,
        note: b.note ? String(b.note).trim().slice(0, 500) : null,
        createdById: req.user.id,
      },
    });
    const diff = r2(counted - expectedCash);
    const msg = Math.abs(diff) < 0.01 ? "Day closed. Cash matches." : diff < 0 ? `Day closed. Cash is short by ${Math.abs(diff)}.` : `Day closed. Cash is over by ${diff}.`;
    return res.status(201).json({ status: "success", message: msg, data: closing });
  } catch (error) {
    logger.error(`Close day error: ${error.message}`);
    next(error);
  }
};

/** GET /cash/closing?from=&to=&userId= – saved closings (own only without cashClosing:view). */
exports.listClosings = async (req, res, next) => {
  try {
    const from = req.query.from || dayjs().subtract(30, "day").format("YYYY-MM-DD");
    const to = req.query.to || dayjs().format("YYYY-MM-DD");
    const where = { storeId: req.storeId, date: { gte: toDate(from), lte: toDate(to) } };
    if (!canSeeAll(req)) where.userId = req.user.id;
    else if (req.query.userId) where.userId = req.query.userId;
    const [rows, users] = await Promise.all([
      prisma.cashClosing.findMany({ where, orderBy: [{ date: "desc" }, { createdAt: "desc" }] }),
      prisma.user.findMany({ where: { storeId: req.storeId }, select: { id: true, name: true } }),
    ]);
    const U = new Map(users.map((u) => [u.id, u.name]));
    return res.status(200).json({ status: "success", data: rows.map((r) => ({ ...r, userName: U.get(r.userId) || "—", closedBy: U.get(r.createdById) || "—" })) });
  } catch (error) {
    next(error);
  }
};

/** Reopen (delete) a closing so the day can be counted again. Needs cashClosing:delete. */
exports.reopenDay = async (req, res, next) => {
  try {
    const c = await prisma.cashClosing.findFirst({ where: { id: req.params.id, storeId: req.storeId } });
    if (!c) throw apiError.notFound("Closing not found");
    const later = await prisma.cashClosing.count({ where: { storeId: req.storeId, userId: c.userId, date: { gt: toDate(c.date) } } });
    if (later) throw apiError.badRequest("A later day of this drawer is closed. Reopen the latest day first.");
    await prisma.cashClosing.delete({ where: { id: c.id } });
    return res.status(200).json({ status: "success", message: "Day reopened", data: null });
  } catch (error) {
    next(error);
  }
};

/**
 * Cash book / day book: every money movement in [from, to] with the opening balance and a running balance.
 * ?methodId= one payment method (default cash), or "all".
 */
exports.getCashBook = async (req, res, next) => {
  try {
    const from = req.query.from || dayjs().format("YYYY-MM-DD");
    const to = req.query.to || from;
    if (dayjs(to).isBefore(dayjs(from))) throw apiError.badRequest("Invalid date range");
    const methodId = req.query.methodId === "all" ? null : req.query.methodId || CASH;
    const [opening, lines] = await Promise.all([balanceBefore(prisma, req.storeId, from, methodId), moneyMoves(prisma, req.storeId, { from, to, methodId })]);
    let bal = opening;
    const rows = lines.map((l) => {
      bal = r2(bal + l.in - l.out);
      return { ...l, balance: bal };
    });
    const days = {};
    rows.forEach((l) => {
      days[l.date] ||= { date: l.date, in: 0, out: 0 };
      days[l.date].in = r2(days[l.date].in + l.in);
      days[l.date].out = r2(days[l.date].out + l.out);
    });
    const totalIn = r2(rows.reduce((a, l) => a + l.in, 0));
    const totalOut = r2(rows.reduce((a, l) => a + l.out, 0));
    return res.status(200).json({
      status: "success",
      data: { from, to, methodId: methodId || "all", opening, totalIn, totalOut, closing: r2(opening + totalIn - totalOut), lines: rows, days: Object.values(days) },
    });
  } catch (error) {
    logger.error(`Cash book error: ${error.message}`);
    next(error);
  }
};
