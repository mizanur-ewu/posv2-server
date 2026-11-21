const dayjs = require("dayjs");
const { logger } = require("../../utils/logger");
const { prisma } = require("../../config/db");
const apiError = require("../../utils/apiError");
const { r2, r3, ctxOf, toDate } = require("../../utils/helperFunction");
const { roleCan } = require("../../utils/permissions");
const { ensureDiscountsSwept, lotAvailable } = require("../../utils/stock/stockWork");
const { loadLookups, skuViews, invoiceViews, issueViews, ISSUE_INCLUDE } = require("../../utils/viewHelper");
const { supplierDueRows, stockEntryTotals } = require("../supplier.controller");
const { staffParties, staffLedgers, staffBalance } = require("../due.controller");

const sum = (arr, k) => r2(arr.reduce((a, x) => a + (typeof k === "function" ? k(x) : x[k] || 0), 0));
const LOW_STOCK = 30;
const EXPIRY_DAYS = 30;
const CHANNELS = ["pos", "sr_sale", "delivery"];

/** ?from=YYYY-MM-DD&to=YYYY-MM-DD (default: today) plus the period of the same length just before it. */
const periodOf = (req) => {
  const from = dayjs(req.query.from || undefined).startOf("day");
  const to = dayjs(req.query.to || req.query.from || undefined).endOf("day");
  if (!from.isValid() || !to.isValid() || to.isBefore(from)) throw apiError.badRequest("Invalid date range");
  const days = to.startOf("day").diff(from, "day") + 1;
  const prevFrom = from.subtract(days, "day");
  return { from, to, days, prevFrom, prevTo: from.subtract(1, "millisecond") };
};

/** Sales figures for a list of invoice views. */
const salesTotals = (invs) => {
  const net = sum(invs, "totalAmount");
  const returned = sum(invs, "returnedAmount");
  const profit = sum(invs, "profit");
  const netAfterReturn = r2(net - returned);
  return {
    invoices: invs.length,
    gross: sum(invs, "subtotal"),
    discount: sum(invs, "totalDiscount"), // line + bill discounts + voucher
    vat: sum(invs, "vatAmount"),
    net,
    returned,
    netAfterReturn,
    collected: sum(invs, (i) => i.totalPaid - i.refundedAmount),
    due: sum(invs, "totalDue"),
    cost: sum(invs, "cost"),
    profit,
    margin: netAfterReturn ? r2((profit / netAfterReturn) * 100) : 0,
    avgInvoice: invs.length ? r2(netAfterReturn / invs.length) : 0,
  };
};

/**
 * Everything the dashboard shows. Period figures follow ?from&to (default today);
 * balances (receivable, payable, staff due, stock …) are as of now.
 * A section the signed-in role can't open is left out (null).
 */
exports.getDashboard = async (req, res, next) => {
  try {
    await ensureDiscountsSwept(prisma, ctxOf(req));
    const storeId = req.storeId;
    const where = { storeId };
    const can = (page) => roleCan(req.role, req.subscription, page);
    const P = periodOf(req);
    const dRange = { gte: toDate(P.from), lte: toDate(P.to) }; // @db.Date columns
    const tRange = { gte: P.from.toDate(), lte: P.to.toDate() }; // DateTime columns
    const now = dayjs();
    const dealer = can("issues") || can("orders") || can("settlement");

    const [L, invoices, prevInvoices, payments, refunds, expenses, expenseCats, tripExpenses, stocks, supplierPaid, adjustments, recent, openDue, ordersTaken, issuesOut, settled, openIssues, pending] =
      await Promise.all([
        loadLookups(prisma, storeId, { lots: true }),
        prisma.salesInvoice.findMany({ where: { ...where, soldDate: tRange }, include: { details: true }, orderBy: { soldDate: "desc" } }),
        prisma.salesInvoice.findMany({
          where: { ...where, soldDate: { gte: P.prevFrom.toDate(), lte: P.prevTo.toDate() } },
          select: { totalAmount: true, returnedAmount: true, vatAmount: true, details: { select: { salesQuantity: true, returnedQuantity: true, purchasePrice: true } } },
        }),
        prisma.customerPayment.findMany({ where: { ...where, date: dRange }, select: { amount: true, paymentMethodId: true, dueCollection: true, issueId: true } }),
        prisma.salesReturn.findMany({ where: { ...where, returnDate: tRange }, select: { totalAmount: true, refundAmount: true, dueAdjusted: true } }),
        prisma.expense.findMany({ where: { ...where, date: dRange }, select: { amount: true, categoryId: true, paymentMethodId: true } }),
        prisma.expenseCategory.findMany({ where, select: { id: true, name: true } }),
        prisma.productIssue.findMany({ where: { ...where, status: "settled", settledAt: tRange }, select: { totalExpense: true } }),
        prisma.stock.findMany({ where: { ...where, date: dRange } }),
        prisma.supplierPayment.findMany({ where: { ...where, date: dRange }, select: { amount: true } }),
        prisma.stockAdjustment.findMany({ where: { ...where, date: dRange }, select: { adjustmentType: true, direction: true, amount: true, quantity: true } }),
        prisma.salesInvoice.findMany({ where, include: { details: true }, orderBy: { soldDate: "desc" }, take: 8 }),
        prisma.salesInvoice.findMany({ where: { ...where, totalDue: { gt: 0 } }, select: { soldToId: true, totalDue: true, soldDate: true } }),
        dealer ? prisma.salesOrder.findMany({ where: { ...where, orderDate: tRange }, select: { totalAmount: true, status: true } }) : [],
        dealer ? prisma.productIssue.findMany({ where: { ...where, date: dRange }, select: { id: true, status: true } }) : [],
        dealer ? prisma.productIssue.findMany({ where: { ...where, status: "settled", settledAt: tRange }, select: { cashShortExcess: true, totalSales: true, cashCollected: true } }) : [],
        dealer ? prisma.productIssue.findMany({ where: { ...where, status: "open" }, include: ISSUE_INCLUDE, orderBy: [{ date: "desc" }, { issueNo: "desc" }] }) : [],
        dealer ? prisma.salesOrder.aggregate({ where: { ...where, status: "pending" }, _count: { _all: true }, _sum: { totalAmount: true } }) : null,
      ]);

    /* ---------- sales in the period ---------- */
    const invs = await invoiceViews(prisma, L, invoices);
    const sales = salesTotals(invs);
    const prevNet = r2(prevInvoices.reduce((a, i) => a + i.totalAmount - i.returnedAmount, 0));
    const prevProfit = r2(
      prevInvoices.reduce(
        (a, i) =>
          a +
          (i.totalAmount - i.returnedAmount) * (i.totalAmount > 0 ? (i.totalAmount - i.vatAmount) / i.totalAmount : 1) -
          i.details.reduce((c, d) => c + (d.salesQuantity - d.returnedQuantity) * d.purchasePrice, 0),
        0,
      ),
    );
    sales.previous = { netAfterReturn: prevNet, profit: prevProfit, invoices: prevInvoices.length };

    const channelOpen = (c) => (c === "pos" ? can("pos") : dealer);
    const byChannel = CHANNELS.map((c) => ({ channel: c, ...salesTotals(invs.filter((i) => i.channel === c)) })).filter((c) => c.invoices > 0 || channelOpen(c.channel));

    const prod = {};
    invoices.forEach((i) =>
      i.details.forEach((d) => {
        const k = d.stockSummaryId;
        const net = d.salesQuantity - d.returnedQuantity;
        prod[k] ||= { skuId: k, sku: L.skuCode(k), ...L.pInfo(d.productId), qty: 0, amount: 0, cost: 0 };
        prod[k].qty += net;
        prod[k].amount += d.salesQuantity ? d.total * (net / d.salesQuantity) : 0;
        prod[k].cost += net * d.purchasePrice;
      }),
    );
    const topProducts = Object.values(prod)
      .map((p) => ({ ...p, qty: r3(p.qty), amount: r2(p.amount), cost: r2(p.cost), profit: r2(p.amount - p.cost) }))
      .filter((p) => p.qty > 0)
      .sort((a, b) => b.amount - a.amount)
      .slice(0, 10);

    const cust = {};
    invs
      .filter((i) => i.soldToId)
      .forEach((i) => {
        cust[i.soldToId] ||= { id: i.soldToId, name: i.customer, type: i.customerType, invoices: 0, amount: 0, due: 0 };
        cust[i.soldToId].invoices += 1;
        cust[i.soldToId].amount = r2(cust[i.soldToId].amount + i.totalAmount - i.returnedAmount);
        cust[i.soldToId].due = r2(cust[i.soldToId].due + i.totalDue);
      });
    const topCustomers = Object.values(cust).sort((a, b) => b.amount - a.amount).slice(0, 8);

    /* ---------- money in / out in the period ---------- */
    const byMethod = L.paymentMethods
      ? [...L.paymentMethods.values()].map((m) => ({ id: m.id, name: m.name, amount: sum(payments.filter((p) => p.paymentMethodId === m.id), "amount") }))
      : [];
    const refunded = sum(refunds, "refundAmount");
    const collections = {
      total: sum(payments, "amount"),
      atSale: sum(payments.filter((p) => !p.dueCollection), "amount"),
      dueCollected: sum(payments.filter((p) => p.dueCollection), "amount"),
      byMethod: byMethod.filter((m) => m.amount),
      refunded,
      returns: { count: refunds.length, value: sum(refunds, "totalAmount"), dueAdjusted: sum(refunds, "dueAdjusted") },
    };

    const showExpense = can("expenses");
    const catName = new Map(expenseCats.map((c) => [c.id, c.name]));
    const expCat = {};
    expenses.forEach((e) => {
      expCat[e.categoryId] ||= { name: catName.get(e.categoryId) || "—", amount: 0, count: 0 };
      expCat[e.categoryId].amount = r2(expCat[e.categoryId].amount + e.amount);
      expCat[e.categoryId].count += 1;
    });
    const storeExpense = sum(expenses, "amount");
    const tripExpense = sum(tripExpenses, "totalExpense");
    const expense = {
      total: r2(storeExpense + tripExpense),
      store: storeExpense,
      trip: tripExpense,
      count: expenses.length,
      byCategory: Object.values(expCat).sort((a, b) => b.amount - a.amount),
    };

    const showPurchase = can("stock") || can("supplierPayments");
    const stockTotal = stocks.length ? await stockEntryTotals(prisma, storeId, stocks) : () => 0;
    const purchase = { entries: stocks.length, value: sum(stocks, stockTotal), supplierPaid: sum(supplierPaid, "amount"), payments: supplierPaid.length };

    const adj = {};
    adjustments.forEach((a) => {
      adj[a.adjustmentType] ||= { type: a.adjustmentType, direction: a.direction, count: 0, amount: 0 };
      adj[a.adjustmentType].count += 1;
      adj[a.adjustmentType].amount = r2(adj[a.adjustmentType].amount + a.amount);
    });
    const stockLoss = r2(["damage", "expired", "lost"].reduce((a, k) => a + (adj[k]?.amount || 0), 0) - (adj.count_gain?.amount || 0));

    const moneyIn = collections.total;
    const moneyOut = r2(refunded + storeExpense + tripExpense + purchase.supplierPaid);
    const cashFlow = {
      in: moneyIn,
      out: moneyOut,
      net: r2(moneyIn - moneyOut),
      lines: [
        { key: "collected", label: "Collected from customers", amount: moneyIn, sign: 1 },
        { key: "refunded", label: "Refunded to customers", amount: refunded, sign: -1 },
        ...(showExpense ? [{ key: "expense", label: "Expenses", amount: storeExpense, sign: -1 }] : []),
        ...(dealer ? [{ key: "trip", label: "SR / delivery trip expenses", amount: tripExpense, sign: -1 }] : []),
        ...(showPurchase ? [{ key: "supplier", label: "Paid to suppliers", amount: purchase.supplierPaid, sign: -1 }] : []),
      ],
    };

    const profitLoss = {
      revenue: sales.netAfterReturn,
      vat: sales.vat,
      cost: sales.cost,
      grossProfit: sales.profit,
      expense: showExpense ? expense.total : 0,
      stockLoss,
      netProfit: r2(sales.profit - (showExpense ? expense.total : 0) - stockLoss),
    };

    /* ---------- balances as of now ---------- */
    const custDue = {};
    let walkInDue = 0;
    openDue.forEach((i) => {
      if (!i.soldToId) {
        walkInDue += i.totalDue;
        return;
      }
      custDue[i.soldToId] ||= { id: i.soldToId, name: L.cName(i.soldToId), type: L.customers.get(i.soldToId)?.customerType, phone: L.customers.get(i.soldToId)?.phone, due: 0, invoices: 0, oldest: i.soldDate };
      const c = custDue[i.soldToId];
      c.due = r2(c.due + i.totalDue);
      c.invoices += 1;
      if (i.soldDate < c.oldest) c.oldest = i.soldDate;
    });
    const custRows = Object.values(custDue).sort((a, b) => b.due - a.due);
    const receivable = {
      total: sum(openDue, "totalDue"),
      customers: custRows.length,
      walkIn: r2(walkInDue),
      over30: sum(openDue.filter((i) => now.diff(dayjs(i.soldDate), "day") > 30), "totalDue"),
      top: custRows.slice(0, 6),
    };

    let payable = null;
    if (can("supplierPayments") || can("stock")) {
      const rows = (await supplierDueRows(prisma, storeId)).filter((s) => s.due > 0.004).sort((a, b) => b.due - a.due);
      payable = { total: sum(rows, "due"), suppliers: rows.length, top: rows.slice(0, 6).map((s) => ({ id: s.id, name: s.name, phone: s.phone, purchase: s.purchase, paid: s.paid, due: s.due })) };
    }

    let staffDue = null;
    if (can("customerDues")) {
      const [parties, ledgers] = await Promise.all([staffParties(prisma, storeId), staffLedgers(prisma, storeId)]);
      const rows = parties
        .map((p) => ({ key: p.key, name: p.name, kind: p.kind, phone: p.phone, ...staffBalance(ledgers.get(p.key) || []) }))
        .filter((x) => x.due > 0)
        .sort((a, b) => b.due - a.due);
      staffDue = { total: sum(rows, "due"), people: rows.length, top: rows.slice(0, 6) };
    }

    const skus = skuViews(L);
    const live = skus.filter((s) => s.stockQuantity > 0 || s.issuedQuantity > 0);
    const expiringLots = L.lots
      .filter((l) => l.expiryDate && lotAvailable(l) > 0 && dayjs(l.expiryDate).diff(now.startOf("day"), "day") <= EXPIRY_DAYS)
      .map((l) => ({
        id: l.id,
        seq: l.seq,
        expiryDate: l.expiryDate,
        available: lotAvailable(l),
        valueCost: r2(lotAvailable(l) * l.purchasePrice),
        ...L.pInfo(l.productId),
        sku: L.skuCode(l.stockSummaryId),
        days: dayjs(l.expiryDate).diff(now.startOf("day"), "day"),
      }))
      .sort((a, b) => a.days - b.days);
    const soldSkus = new Set(skus.filter((s) => s.soldQuantity > 0 || s.stockQuantity > 0 || s.issuedQuantity > 0).map((s) => s.id));
    const low = skus.filter((s) => soldSkus.has(s.id) && !s.discount && s.stockQuantity < LOW_STOCK).sort((a, b) => a.stockQuantity - b.stockQuantity);
    const stock = {
      products: new Set(live.map((s) => s.productId)).size,
      skus: live.length,
      units: r3(live.reduce((a, s) => a + s.stockQuantity, 0)),
      valueCost: sum(skus, "stockValueCost"),
      valueSale: sum(skus, "stockValueSale"),
      issuedValue: sum(skus, (s) => s.issuedQuantity * s.sellingPrice),
      lowCount: low.filter((s) => s.stockQuantity > 0).length,
      outCount: low.filter((s) => s.stockQuantity <= 0).length,
      expiringCount: expiringLots.filter((l) => l.days >= 0).length,
      expiredCount: expiringLots.filter((l) => l.days < 0).length,
      expiringValue: sum(expiringLots, "valueCost"),
      lowThreshold: LOW_STOCK,
      expiryDays: EXPIRY_DAYS,
      low: low.slice(0, 8).map((s) => ({ id: s.id, sku: s.sku, productName: s.productName, unit: s.unit, sellingPrice: s.sellingPrice, stockQuantity: s.stockQuantity, issuedQuantity: s.issuedQuantity })),
      expiring: expiringLots.slice(0, 8),
      adjustments: Object.values(adj),
    };

    const dealerData = dealer
      ? {
          ordersTaken: ordersTaken.length,
          orderValue: sum(ordersTaken, "totalAmount"),
          issuesOut: issuesOut.length,
          settled: settled.length,
          settledSales: sum(settled, "totalSales"),
          settledCollected: sum(settled, "cashCollected"),
          cashShortExcess: sum(settled, "cashShortExcess"),
          pendingOrders: pending?._count._all || 0,
          pendingOrderValue: r2(pending?._sum.totalAmount || 0),
          openIssues: await issueViews(prisma, L, openIssues),
        }
      : null;

    const data = {
      period: { from: P.from.format("YYYY-MM-DD"), to: P.to.format("YYYY-MM-DD"), days: P.days },
      sales,
      byChannel,
      topProducts,
      topCustomers,
      collections,
      expense: showExpense ? expense : null,
      purchase: showPurchase ? purchase : null,
      cashFlow,
      profitLoss,
      receivable,
      payable,
      staffDue,
      stock,
      dealer: dealerData,
      recentInvoices: await invoiceViews(prisma, L, recent),
    };
    return res.status(200).json({ status: "success", data });
  } catch (error) {
    logger.error(`Dashboard error: ${error.message}`);
    next(error);
  }
};
