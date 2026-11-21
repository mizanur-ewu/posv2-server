const dayjs = require("dayjs");
const { logger } = require("../../utils/logger");
const { prisma } = require("../../config/db");
const apiError = require("../../utils/apiError");
const { r2, r3, ctxOf, toDate } = require("../../utils/helperFunction");
const { ensureDiscountsSwept, lotAvailable } = require("../../utils/stock/stockWork");
const { loadLookups, skuViews, invoiceViews, issueViews, ISSUE_INCLUDE } = require("../../utils/viewHelper");

/** ?from=YYYY-MM-DD&to=YYYY-MM-DD → { from, to } as Date bounds (defaults: last 30 days). */
const rangeOf = (req) => {
  const from = dayjs(req.query.from || dayjs().subtract(29, "day"));
  const to = dayjs(req.query.to || dayjs());
  if (!from.isValid() || !to.isValid()) throw apiError.badRequest("Invalid date range");
  return {
    gte: from.startOf("day").toDate(),
    lte: to.endOf("day").toDate(),
    dateFrom: toDate(from),
    dateTo: toDate(to),
  };
};

/** Sales report: every invoice in the range and a day-wise summary. ?channel= */
exports.getSalesReport = async (req, res, next) => {
  try {
    const r = rangeOf(req);
    const where = { storeId: req.storeId, soldDate: { gte: r.gte, lte: r.lte } };
    if (req.query.channel) where.channel = req.query.channel;
    const [L, invoices] = await Promise.all([
      loadLookups(prisma, req.storeId),
      prisma.salesInvoice.findMany({ where, include: { details: true }, orderBy: { soldDate: "desc" } }),
    ]);
    const invs = await invoiceViews(prisma, L, invoices);
    const days = {};
    invs.forEach((i) => {
      const k = dayjs(i.soldDate).format("YYYY-MM-DD");
      days[k] ||= { date: k, invoices: 0, gross: 0, discount: 0, vat: 0, net: 0, returned: 0, paid: 0, due: 0, profit: 0 };
      const d = days[k];
      d.invoices += 1;
      d.gross = r2(d.gross + i.subtotal);
      d.discount = r2(d.discount + i.totalDiscount);
      d.vat = r2(d.vat + i.vatAmount);
      d.net = r2(d.net + i.totalAmount);
      d.returned = r2(d.returned + i.returnedAmount);
      d.paid = r2(d.paid + i.totalPaid - i.refundedAmount);
      d.due = r2(d.due + i.totalDue);
      d.profit = r2(d.profit + i.profit);
    });
    const data = { invoices: invs, daily: Object.values(days).sort((a, b) => a.date.localeCompare(b.date)) };
    return res.status(200).json({ status: "success", data });
  } catch (error) {
    logger.error(`Sales report error: ${error.message}`);
    next(error);
  }
};

/** Current stock per SKU. */
exports.getStockReport = async (req, res, next) => {
  try {
    await ensureDiscountsSwept(prisma, ctxOf(req));
    const L = await loadLookups(prisma, req.storeId, { lots: true });
    return res.status(200).json({ status: "success", data: skuViews(L) });
  } catch (error) {
    logger.error(`Stock report error: ${error.message}`);
    next(error);
  }
};

/** Profit per SKU with the exact lot cost (FIFO). Bill discounts are spread over the lines. */
exports.getProfitReport = async (req, res, next) => {
  try {
    const r = rangeOf(req);
    const [L, invoices] = await Promise.all([
      loadLookups(prisma, req.storeId),
      prisma.salesInvoice.findMany({ where: { storeId: req.storeId, soldDate: { gte: r.gte, lte: r.lte } }, include: { details: true } }),
    ]);
    const m = {};
    invoices.forEach((i) => {
      const billDisc = i.totalDiscount - i.details.reduce((a, d) => a + d.discountAmount, 0);
      const lineSum = i.details.reduce((a, d) => a + d.total, 0) || 1;
      i.details.forEach((d) => {
        const k = d.stockSummaryId;
        const sku = L.skus.get(k);
        m[k] ||= { skuId: k, sku: sku?.sku, ...L.pInfo(d.productId), skuDiscount: L.skuDiscount(sku), sellingPrice: sku?.sellingPrice, qty: 0, revenue: 0, cost: 0 };
        const net = d.salesQuantity - d.returnedQuantity;
        const ratio = net / d.salesQuantity;
        const rev = (d.total - (billDisc * d.total) / lineSum) * ratio;
        m[k].qty = r3(m[k].qty + net);
        m[k].revenue = r2(m[k].revenue + rev);
        m[k].cost = r2(m[k].cost + net * d.purchasePrice); // exact lot cost (FIFO)
      });
    });
    const data = Object.values(m)
      .map((x) => ({ ...x, profit: r2(x.revenue - x.cost), margin: x.revenue ? r2(((x.revenue - x.cost) / x.revenue) * 100) : 0 }))
      .sort((a, b) => b.profit - a.profit);
    return res.status(200).json({ status: "success", data });
  } catch (error) {
    logger.error(`Profit report error: ${error.message}`);
    next(error);
  }
};

/** Per SR / delivery man: sales outs, invoices, sales, collection, orders, shortage, cash short / excess. */
exports.getEmployeeReport = async (req, res, next) => {
  try {
    const r = rangeOf(req);
    const where = { storeId: req.storeId };
    const [employees, issues, invoices, orders, shortages] = await Promise.all([
      prisma.employee.findMany({ where, orderBy: { createdAt: "asc" } }),
      prisma.productIssue.findMany({ where: { ...where, date: { gte: r.dateFrom, lte: r.dateTo } }, select: { employeeId: true, cashShortExcess: true } }),
      prisma.salesInvoice.findMany({
        where: { ...where, soldDate: { gte: r.gte, lte: r.lte }, OR: [{ srId: { not: null } }, { deliveryManId: { not: null } }] },
        select: { srId: true, deliveryManId: true, totalAmount: true, returnedAmount: true, totalPaid: true, refundedAmount: true },
      }),
      prisma.salesOrder.findMany({ where: { ...where, orderDate: { gte: r.gte, lte: r.lte } }, select: { srId: true, totalAmount: true } }),
      prisma.stockAdjustment.findMany({ where: { ...where, employeeId: { not: null }, date: { gte: r.dateFrom, lte: r.dateTo } }, select: { employeeId: true, amount: true } }),
    ]);
    const data = employees.map((e) => {
      const iss = issues.filter((i) => i.employeeId === e.id);
      const invs = invoices.filter((i) => i.srId === e.id || i.deliveryManId === e.id);
      const ords = orders.filter((o) => o.srId === e.id);
      return {
        id: e.id,
        name: e.name,
        type: e.type,
        issues: iss.length,
        invoices: invs.length,
        sales: r2(invs.reduce((a, i) => a + i.totalAmount - i.returnedAmount, 0)),
        collected: r2(invs.reduce((a, i) => a + i.totalPaid - i.refundedAmount, 0)),
        orders: ords.length,
        orderValue: r2(ords.reduce((a, o) => a + o.totalAmount, 0)),
        shortage: r2(shortages.filter((a) => a.employeeId === e.id).reduce((a, x) => a + x.amount, 0)),
        cashShortExcess: r2(iss.reduce((a, i) => a + (i.cashShortExcess || 0), 0)),
      };
    });
    return res.status(200).json({ status: "success", data });
  } catch (error) {
    logger.error(`Employee report error: ${error.message}`);
    next(error);
  }
};

/** Settled sales outs in the range. */
exports.getSettlementReport = async (req, res, next) => {
  try {
    const r = rangeOf(req);
    const [L, issues] = await Promise.all([
      loadLookups(prisma, req.storeId),
      prisma.productIssue.findMany({
        where: { storeId: req.storeId, status: "settled", date: { gte: r.dateFrom, lte: r.dateTo } },
        include: ISSUE_INCLUDE,
        orderBy: [{ date: "desc" }, { issueNo: "desc" }],
      }),
    ]);
    return res.status(200).json({ status: "success", data: await issueViews(prisma, L, issues) });
  } catch (error) {
    logger.error(`Settlement report error: ${error.message}`);
    next(error);
  }
};

/** Lots expiring within ?days= (default 30), including stock out with SR / delivery men. */
exports.getExpiryReport = async (req, res, next) => {
  try {
    const days = Number(req.query.days ?? 30);
    const L = await loadLookups(prisma, req.storeId);
    const lots = await prisma.stockDetails.findMany({
      where: { storeId: req.storeId, expiryDate: { not: null, lte: toDate(dayjs().add(days + 1, "day")) } },
    });
    const data = lots
      .filter((l) => lotAvailable(l) + l.issuedQuantity > 0 && dayjs(l.expiryDate).diff(dayjs(), "day") <= days)
      .map((l) => ({
        ...l,
        available: lotAvailable(l),
        ...L.pInfo(l.productId),
        sku: L.skuCode(l.stockSummaryId),
        days: dayjs(l.expiryDate).diff(dayjs().startOf("day"), "day"),
        valueCost: r2(lotAvailable(l) * l.purchasePrice),
      }))
      .sort((a, b) => a.days - b.days);
    return res.status(200).json({ status: "success", data });
  } catch (error) {
    logger.error(`Expiry report error: ${error.message}`);
    next(error);
  }
};

/** Customers with unpaid invoices, biggest due first. */
exports.getDueReport = async (req, res, next) => {
  try {
    const [customers, invoices] = await Promise.all([
      prisma.customer.findMany({ where: { storeId: req.storeId } }),
      prisma.salesInvoice.findMany({ where: { storeId: req.storeId, totalDue: { gt: 0 }, soldToId: { not: null } }, select: { soldToId: true, totalDue: true, soldDate: true } }),
    ]);
    const data = customers
      .map((c) => {
        const invs = invoices.filter((i) => i.soldToId === c.id);
        return {
          id: c.id,
          name: c.name,
          type: c.customerType,
          phone: c.phone,
          invoices: invs.length,
          due: r2(invs.reduce((a, i) => a + i.totalDue, 0)),
          oldest: invs.map((i) => i.soldDate).sort()[0],
        };
      })
      .filter((x) => x.due > 0)
      .sort((a, b) => b.due - a.due);
    return res.status(200).json({ status: "success", data });
  } catch (error) {
    logger.error(`Due report error: ${error.message}`);
    next(error);
  }
};
