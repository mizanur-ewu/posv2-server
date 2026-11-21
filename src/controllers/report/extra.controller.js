const dayjs = require("dayjs");
const { logger } = require("../../utils/logger");
const { prisma } = require("../../config/db");
const apiError = require("../../utils/apiError");
const { r2, r3, ymd, today, toDate, indexBy } = require("../../utils/helperFunction");
const { lotAvailable } = require("../../utils/stock/stockWork");
const { stockTotalsFrom, splitOutQty } = require("../../utils/stock/stockEntry");
const { loadLookups } = require("../../utils/viewHelper");

/**
 * Statements, stock movement, sales breakdown, dead stock, purchases and VAT.
 * Every query is scoped by req.storeId. Dates are compared as business days ("YYYY-MM-DD"):
 * DateTime columns go through ymd() (server time zone), date-only columns already come as strings.
 */

/** ?from=&to= (default: last 30 days) → day strings plus bounds for DateTime and @db.Date columns. */
const periodOf = (req) => {
  const from = dayjs(req.query.from || dayjs().subtract(29, "day"));
  const to = dayjs(req.query.to || dayjs());
  if (!from.isValid() || !to.isValid() || to.isBefore(from, "day")) throw apiError.badRequest("Invalid date range");
  return {
    from: ymd(from),
    to: ymd(to),
    gte: from.startOf("day").toDate(),
    lte: to.endOf("day").toDate(),
    dFrom: toDate(from),
    dTo: toDate(to),
    endsToday: ymd(to) >= today(),
  };
};

const ok = (res, data) => res.status(200).json({ status: "success", data });

/** Product of a row, or its parent (variants) when the row itself has no value for `field`. */
const productField = (L, productId, field) => {
  const p = L.products.get(productId);
  if (!p) return null;
  return p[field] ?? L.products.get(p.parentId)?.[field] ?? null;
};

/**
 * Opening balance, dated lines with a running balance, and the closing balance.
 * events: [{ date, time, order, debit, credit, ... }]. sign 1: balance = debit − credit (customer owes),
 * sign −1: balance = credit − debit (shop owes the supplier).
 */
const buildLedger = (events, P, sign) => {
  const sorted = [...events].sort((a, b) => a.date.localeCompare(b.date) || String(a.time).localeCompare(String(b.time)) || a.order - b.order);
  const move = (e) => sign * (e.debit - e.credit);
  let opening = 0;
  sorted.filter((e) => e.date < P.from).forEach((e) => {
    opening += move(e);
  });
  opening = r2(opening);
  let balance = opening;
  const lines = sorted
    .filter((e) => e.date >= P.from && e.date <= P.to)
    .map(({ time, order, ...e }) => {
      balance = r2(balance + move(e));
      return { ...e, debit: r2(e.debit), credit: r2(e.credit), balance };
    });
  return {
    opening,
    lines,
    closing: balance,
    totalDebit: r2(lines.reduce((a, l) => a + l.debit, 0)),
    totalCredit: r2(lines.reduce((a, l) => a + l.credit, 0)),
  };
};

/* ------------------------------------------------------------------ */
/* 1. Customer statement                                               */
/* ------------------------------------------------------------------ */

/**
 * Ledger of one customer: invoices (debit), payments and returns (credit), refunds paid back in
 * cash (debit). Closing for a range ending today = the customer's current due.
 */
exports.getCustomerStatement = async (req, res, next) => {
  try {
    const P = periodOf(req);
    const storeId = req.storeId;
    const customerId = String(req.query.customerId || "");
    if (!customerId) throw apiError.badRequest("Select a customer");
    const customer = await prisma.customer.findFirst({ where: { id: customerId, storeId } });
    if (!customer) throw apiError.notFound("Customer not found");

    const [invoices, methods] = await Promise.all([
      prisma.salesInvoice.findMany({
        where: { storeId, soldToId: customerId },
        include: { payments: true, details: { select: { id: true } } },
        orderBy: { soldDate: "asc" },
      }),
      prisma.paymentMethod.findMany(),
    ]);
    const M = indexBy(methods);
    const returns = invoices.length
      ? await prisma.salesReturn.findMany({ where: { storeId, invoiceId: { in: invoices.map((i) => i.id) } }, orderBy: { returnDate: "asc" } })
      : [];
    const INV = indexBy(invoices);

    const events = [];
    const atSale = {};
    const collections = {};
    invoices.forEach((inv) => {
      events.push({
        key: `inv:${inv.id}`,
        type: "invoice",
        date: ymd(inv.soldDate),
        time: inv.soldDate,
        order: 0,
        ref: inv.invoiceNo,
        invoiceId: inv.id,
        channel: inv.channel,
        items: inv.details.length,
        debit: inv.totalAmount,
        credit: 0,
      });
      inv.payments.forEach((p) => {
        const method = M.get(p.paymentMethodId)?.name || null;
        if (!p.dueCollection) {
          // paid with the sale (also cash an SR / delivery man took on the trip): one line per invoice
          const k = `pay:${inv.id}`;
          atSale[k] ||= { key: k, type: "payment", atSale: true, date: p.date, time: inv.soldDate, order: 1, ref: inv.invoiceNo, invoiceId: inv.id, methods: [], remark: null, debit: 0, credit: 0 };
          atSale[k].credit += p.amount;
          if (method && !atSale[k].methods.includes(method)) atSale[k].methods.push(method);
          return;
        }
        // a due collection can pay several invoices: one line per collection
        const k = `col:${p.collectionId || p.id}`;
        collections[k] ||= { key: k, type: "payment", atSale: false, date: p.date, time: p.createdAt, order: 4, ref: null, invoices: [], methods: [], remark: p.remark || null, debit: 0, credit: 0 };
        const c = collections[k];
        c.credit += p.amount;
        if (!c.invoices.includes(inv.invoiceNo)) c.invoices.push(inv.invoiceNo);
        if (method && !c.methods.includes(method)) c.methods.push(method);
      });
    });
    events.push(...Object.values(atSale), ...Object.values(collections));
    returns.forEach((r) => {
      const inv = INV.get(r.invoiceId);
      const base = { date: ymd(r.returnDate), time: r.returnDate, ref: r.returnNo, invoiceNo: inv?.invoiceNo, invoiceId: r.invoiceId, remark: r.reason || null };
      events.push({ ...base, key: `ret:${r.id}`, type: "return", order: 2, debit: 0, credit: r.totalAmount });
      if (r.refundAmount > 0) {
        events.push({ ...base, key: `ref:${r.id}`, type: "refund", order: 3, method: M.get(r.paymentMethodId)?.name || null, debit: r.refundAmount, credit: 0 });
      }
    });

    const led = buildLedger(events, P, 1);
    const inPeriod = (type) => r2(led.lines.filter((l) => l.type === type).reduce((a, l) => a + (type === "invoice" || type === "refund" ? l.debit : l.credit), 0));
    const data = {
      customer: { id: customer.id, name: customer.name, phone: customer.phone, address: customer.address, type: customer.customerType, ownerName: customer.ownerName },
      from: P.from,
      to: P.to,
      ...led,
      totals: { invoiced: inPeriod("invoice"), paid: inPeriod("payment"), returned: inPeriod("return"), refunded: inPeriod("refund") },
      // what the Due page shows for this customer right now (sum of every invoice's due)
      currentDue: r2(invoices.reduce((a, i) => a + i.totalDue, 0)),
      endsToday: P.endsToday,
    };
    return ok(res, data);
  } catch (error) {
    logger.error(`Customer statement error: ${error.message}`);
    next(error);
  }
};

/* ------------------------------------------------------------------ */
/* 2. Supplier ledger                                                  */
/* ------------------------------------------------------------------ */

/**
 * What the shop owes one supplier: purchases (credit, stock entry total with VAT), payments and
 * returns to the supplier (debit). Same totals as GET /supplier/dues.
 */
exports.getSupplierLedger = async (req, res, next) => {
  try {
    const P = periodOf(req);
    const storeId = req.storeId;
    const supplierId = String(req.query.supplierId || "");
    if (!supplierId) throw apiError.badRequest("Select a supplier");
    const supplier = await prisma.supplier.findFirst({ where: { id: supplierId, storeId } });
    if (!supplier) throw apiError.notFound("Supplier not found");

    const [stocks, payments, returns, methods, allStocks] = await Promise.all([
      prisma.stock.findMany({ where: { storeId, supplierId } }),
      prisma.supplierPayment.findMany({ where: { storeId, supplierId } }),
      prisma.stockAdjustment.findMany({ where: { storeId, adjustmentType: "supplier_return", supplierId } }),
      prisma.paymentMethod.findMany(),
      prisma.stock.findMany({ where: { storeId }, select: { id: true, code: true } }),
    ]);
    const M = indexBy(methods);
    const ST = indexBy(allStocks);
    const lots = stocks.length
      ? await prisma.stockDetails.findMany({
          where: { storeId, rootStockId: { in: stocks.map((s) => s.id) } },
          select: { id: true, stockId: true, rootStockId: true, productId: true, quantity: true, purchasePrice: true, sourceStockDetailsId: true },
        })
      : [];
    const retLots = returns.length
      ? await prisma.stockDetails.findMany({ where: { storeId, id: { in: returns.map((a) => a.stockDetailsId) } }, select: { id: true, productId: true, rootStockId: true } })
      : [];
    const RL = indexBy(retLots);
    const lotsOf = new Map();
    lots.forEach((l) => {
      if (!lotsOf.has(l.rootStockId)) lotsOf.set(l.rootStockId, []);
      lotsOf.get(l.rootStockId).push(l);
    });
    const L = await loadLookups(prisma, storeId);

    const events = [];
    stocks.forEach((s) => {
      const t = stockTotalsFrom({ stock: s, entryLots: lotsOf.get(s.id) || [], payments: [], returns: [] });
      events.push({
        key: `st:${s.id}`,
        type: "purchase",
        date: s.date,
        time: s.createdAt,
        order: 0,
        ref: s.code,
        stockId: s.id,
        supplierRefNo: s.supplierRefNo,
        items: t.lines,
        subtotal: t.subtotal,
        vat: t.vat,
        vatPercent: s.vatPercent,
        debit: 0,
        credit: t.total,
      });
    });
    // one line per return (an adjustment ref covers several lots)
    const ret = {};
    returns.forEach((a) => {
      const k = `ret:${a.refNo || a.id}`;
      const lot = RL.get(a.stockDetailsId);
      ret[k] ||= { key: k, type: "supplier_return", date: a.date, time: a.createdAt, order: 1, ref: a.refNo, stockCode: ST.get(lot?.rootStockId)?.code || null, products: [], remark: a.reason || null, debit: 0, credit: 0 };
      ret[k].debit += a.amount;
      const name = L.pName(lot?.productId);
      if (!ret[k].products.includes(name)) ret[k].products.push(name);
    });
    events.push(...Object.values(ret));
    payments.forEach((p) => {
      events.push({
        key: `pay:${p.id}`,
        type: "payment",
        date: p.date,
        time: p.createdAt,
        order: 2,
        ref: p.stockId ? ST.get(p.stockId)?.code || null : null,
        stockId: p.stockId,
        method: M.get(p.paymentMethodId)?.name || null,
        remark: p.remark || null,
        debit: p.amount,
        credit: 0,
      });
    });

    const led = buildLedger(events, P, -1);
    const sumType = (type, k) => r2(led.lines.filter((l) => l.type === type).reduce((a, l) => a + l[k], 0));
    const purchaseAll = r2(events.filter((e) => e.type === "purchase").reduce((a, e) => a + e.credit, 0));
    const returnedAll = r2(returns.reduce((a, x) => a + x.amount, 0));
    const paidAll = r2(payments.reduce((a, p) => a + p.amount, 0));
    const data = {
      supplier: { id: supplier.id, name: supplier.name, phone: supplier.phone, address: supplier.address, email: supplier.email },
      from: P.from,
      to: P.to,
      ...led,
      totals: { purchased: sumType("purchase", "credit"), returned: sumType("supplier_return", "debit"), paid: sumType("payment", "debit") },
      // same figure as GET /supplier/dues for this supplier
      currentDue: r2(purchaseAll - returnedAll - paidAll),
      endsToday: P.endsToday,
    };
    return ok(res, data);
  } catch (error) {
    logger.error(`Supplier ledger error: ${error.message}`);
    next(error);
  }
};

/* ------------------------------------------------------------------ */
/* 3. Stock movement                                                   */
/* ------------------------------------------------------------------ */

const OUT_TYPES = ["supplier_return", "damage", "expired", "lost", "shortage"];

/**
 * Per product: opening, in (received, customer returns, count gains), out (sold, supplier returns,
 * damaged, expired, lost, SR shortage) and closing, in quantity and at lot cost.
 * Stock = what the shop owns: in the store + out with SR / delivery men. Sales outs, their returns
 * and discount / reprice splits move stock inside the shop and are not counted.
 * "Received" = every lot by the date of the stock entry it came from (split lots share their
 * entry, so the sum is the received quantity of the entry lots).
 */
exports.getStockMovement = async (req, res, next) => {
  try {
    const P = periodOf(req);
    const storeId = req.storeId;
    const where = { storeId };
    const [L, lots, stocks, sold, returned, adjustments] = await Promise.all([
      loadLookups(prisma, storeId),
      prisma.stockDetails.findMany({
        where,
        select: { id: true, productId: true, stockId: true, rootStockId: true, quantity: true, soldQuantity: true, adjustQuantity: true, issuedQuantity: true, purchasePrice: true, date: true },
      }),
      prisma.stock.findMany({ where, select: { id: true, date: true } }),
      prisma.invoiceDetails.findMany({
        where: { ...where, invoice: { soldDate: { lte: P.lte } } },
        select: { productId: true, salesQuantity: true, purchasePrice: true, invoice: { select: { soldDate: true } } },
      }),
      prisma.salesReturnDetails.findMany({
        where: { ...where, salesReturn: { returnDate: { lte: P.lte } } },
        select: { productId: true, stockDetailsId: true, returnQuantity: true, salesReturn: { select: { returnDate: true } } },
      }),
      prisma.stockAdjustment.findMany({ where: { ...where, date: { lte: P.dTo } }, select: { stockDetailsId: true, adjustmentType: true, direction: true, quantity: true, date: true } }),
    ]);
    const LOT = indexBy(lots);
    const stockDate = new Map(stocks.map((s) => [s.id, s.date]));

    const M = {};
    const row = (pid) =>
      (M[pid] ||= {
        productId: pid,
        opening: 0,
        openingValue: 0,
        received: 0,
        customerReturn: 0,
        countGain: 0,
        sold: 0,
        supplier_return: 0,
        damage: 0,
        expired: 0,
        lost: 0,
        shortage: 0,
        inValue: 0,
        outValue: 0,
      });
    const add = (pid, day, field, q, cost, dir) => {
      if (!pid || !day || day > P.to || !q) return;
      const m = row(pid);
      if (day < P.from) {
        m.opening += dir * q;
        m.openingValue += dir * q * cost;
        return;
      }
      m[field] += q;
      if (dir > 0) m.inValue += q * cost;
      else m.outValue += q * cost;
    };

    lots.forEach((l) => add(l.productId, stockDate.get(l.rootStockId || l.stockId) || l.date, "received", l.quantity, l.purchasePrice, 1));
    sold.forEach((d) => add(d.productId, ymd(d.invoice.soldDate), "sold", d.salesQuantity, d.purchasePrice, -1));
    returned.forEach((d) => add(d.productId, ymd(d.salesReturn.returnDate), "customerReturn", d.returnQuantity, LOT.get(d.stockDetailsId)?.purchasePrice || 0, 1));
    adjustments.forEach((a) => {
      const lot = LOT.get(a.stockDetailsId);
      if (!lot) return;
      if ((a.direction || "out") === "in") add(lot.productId, a.date, "countGain", a.quantity, lot.purchasePrice, 1);
      else add(lot.productId, a.date, OUT_TYPES.includes(a.adjustmentType) ? a.adjustmentType : "lost", a.quantity, lot.purchasePrice, -1);
    });

    // what the shop owns right now, per product: from the SKU cache and from the lots
    const nowSku = {};
    L.skuList.forEach((s) => {
      nowSku[s.productId] = (nowSku[s.productId] || 0) + s.stockQuantity + s.issuedQuantity;
    });
    const nowLots = {};
    const nowValue = {};
    lots.forEach((l) => {
      const owned = lotAvailable(l) + l.issuedQuantity;
      nowLots[l.productId] = (nowLots[l.productId] || 0) + owned;
      nowValue[l.productId] = (nowValue[l.productId] || 0) + owned * l.purchasePrice;
    });
    // products with stock now but no movement at all still show up (opening = closing)
    Object.keys(nowLots).forEach((pid) => row(pid));

    const rows = Object.values(M)
      .map((m) => {
        const inQty = r3(m.received + m.customerReturn + m.countGain);
        const outQty = r3(m.sold + OUT_TYPES.reduce((a, k) => a + m[k], 0));
        const closing = r3(m.opening + inQty - outQty);
        const out = {
          productId: m.productId,
          productCode: L.products.get(m.productId)?.code,
          ...L.pInfo(m.productId),
          opening: r3(m.opening),
          openingValue: r2(m.openingValue),
          received: r3(m.received),
          customerReturn: r3(m.customerReturn),
          countGain: r3(m.countGain),
          inQty,
          inValue: r2(m.inValue),
          sold: r3(m.sold),
          supplierReturn: r3(m.supplier_return),
          damaged: r3(m.damage),
          expired: r3(m.expired),
          lost: r3(m.lost),
          shortage: r3(m.shortage),
          outQty,
          outValue: r2(m.outValue),
          closing,
          closingValue: r2(m.openingValue + m.inValue - m.outValue),
        };
        if (P.endsToday) {
          out.currentQty = r3(nowSku[m.productId] || 0);
          out.currentLotQty = r3(nowLots[m.productId] || 0);
          out.currentValue = r2(nowValue[m.productId] || 0);
          out.mismatch = Math.abs(out.currentQty - closing) > 0.0005 || Math.abs(out.currentLotQty - closing) > 0.0005;
        }
        return out;
      })
      .filter((x) => x.opening || x.inQty || x.outQty || x.closing || x.mismatch)
      .sort((a, b) => a.productName.localeCompare(b.productName));

    const sumK = (k, f = r2) => f(rows.reduce((a, x) => a + (x[k] || 0), 0));
    const data = {
      from: P.from,
      to: P.to,
      rows,
      totals: {
        openingValue: sumK("openingValue"),
        inValue: sumK("inValue"),
        outValue: sumK("outValue"),
        closingValue: sumK("closingValue"),
        products: rows.length,
      },
      // only when the range ends today: closing must equal stock in the store + out with SR / delivery
      checked: P.endsToday,
      mismatches: P.endsToday ? rows.filter((x) => x.mismatch).map((x) => ({ productId: x.productId, productName: x.productName, closing: x.closing, currentQty: x.currentQty, currentLotQty: x.currentLotQty })) : [],
    };
    return ok(res, data);
  } catch (error) {
    logger.error(`Stock movement report error: ${error.message}`);
    next(error);
  }
};

/* ------------------------------------------------------------------ */
/* 4. Sales by product / category / brand / cashier                    */
/* ------------------------------------------------------------------ */

const GROUPS = ["product", "category", "brand", "cashier"];

/**
 * Sales in the range grouped by product, category, brand or cashier (the user who recorded the sale).
 * Figures are net of customer returns. Bill discounts / vouchers are spread over the lines like the
 * profit report, so net sales here = profit report revenue (VAT not included). Cost = exact lot cost.
 */
exports.getSalesBy = async (req, res, next) => {
  try {
    const P = periodOf(req);
    const group = GROUPS.includes(req.query.group) ? req.query.group : "product";
    const where = { storeId: req.storeId, soldDate: { gte: P.gte, lte: P.lte } };
    if (req.query.channel) where.channel = String(req.query.channel);
    const [L, invoices] = await Promise.all([loadLookups(prisma, req.storeId), prisma.salesInvoice.findMany({ where, include: { details: true } })]);

    const keyOf = (inv, d) => {
      if (group === "product") return d.productId;
      if (group === "category") return productField(L, d.productId, "categoryId") || "none";
      if (group === "brand") return productField(L, d.productId, "brandId") || "none";
      return inv.soldById;
    };
    const labelOf = (k) => {
      if (group === "product") return { name: L.pName(k), ...L.pInfo(k), productCode: L.products.get(k)?.code };
      if (k === "none") return { name: group === "category" ? "No category" : "No brand", none: true };
      if (group === "category") return { name: L.categories.get(k)?.name || "—" };
      if (group === "brand") return { name: L.brands.get(k)?.name || "—" };
      return { name: L.uName(k) };
    };

    const m = {};
    invoices.forEach((inv) => {
      const lineSum = inv.details.reduce((a, d) => a + d.total, 0);
      const billDisc = inv.totalDiscount - inv.details.reduce((a, d) => a + d.discountAmount, 0);
      inv.details.forEach((d) => {
        const k = keyOf(inv, d);
        const g = (m[k] ||= { key: k, soldQty: 0, returnedQty: 0, gross: 0, discount: 0, net: 0, cost: 0, invoiceIds: new Set(), productIds: new Set() });
        const netQty = d.salesQuantity - d.returnedQuantity;
        const ratio = d.salesQuantity ? netQty / d.salesQuantity : 0;
        const billShare = lineSum ? (billDisc * d.total) / lineSum : 0;
        g.soldQty += d.salesQuantity;
        g.returnedQty += d.returnedQuantity;
        g.gross += d.unitPrice * netQty;
        g.discount += (d.discountAmount + billShare) * ratio;
        g.net += (d.total - billShare) * ratio;
        g.cost += netQty * d.purchasePrice;
        g.invoiceIds.add(inv.id);
        g.productIds.add(d.productId);
      });
    });

    const rows = Object.values(m)
      .map((g) => {
        const net = r2(g.net);
        const cost = r2(g.cost);
        const profit = r2(net - cost);
        return {
          key: g.key,
          ...labelOf(g.key),
          soldQty: r3(g.soldQty),
          returnedQty: r3(g.returnedQty),
          qty: r3(g.soldQty - g.returnedQty),
          gross: r2(g.gross),
          discount: r2(g.discount),
          net,
          cost,
          profit,
          margin: net ? r2((profit / net) * 100) : 0,
          invoices: g.invoiceIds.size,
          products: g.productIds.size,
        };
      })
      .sort((a, b) => b.net - a.net);
    const sumK = (k) => r2(rows.reduce((a, x) => a + x[k], 0));
    const totals = { gross: sumK("gross"), discount: sumK("discount"), net: sumK("net"), cost: sumK("cost"), profit: sumK("profit"), invoices: invoices.length };
    totals.margin = totals.net ? r2((totals.profit / totals.net) * 100) : 0;
    return ok(res, { from: P.from, to: P.to, group, rows, totals });
  } catch (error) {
    logger.error(`Sales breakdown report error: ${error.message}`);
    next(error);
  }
};

/* ------------------------------------------------------------------ */
/* 5. Dead stock                                                       */
/* ------------------------------------------------------------------ */

/**
 * Products that have stock (in the store or out with SR / delivery) and have not sold for ?days= (default 60).
 * A product that never sold counts from the day it was first received, so stock that just came in is not "dead".
 */
exports.getDeadStock = async (req, res, next) => {
  try {
    const days = Math.max(1, Math.min(3650, Number(req.query.days) || 60));
    const storeId = req.storeId;
    const where = { storeId };
    const [L, lots, stocks, sales] = await Promise.all([
      loadLookups(prisma, storeId),
      prisma.stockDetails.findMany({
        where,
        select: { id: true, productId: true, stockSummaryId: true, stockId: true, rootStockId: true, quantity: true, soldQuantity: true, adjustQuantity: true, issuedQuantity: true, purchasePrice: true, date: true },
      }),
      prisma.stock.findMany({ where, select: { id: true, date: true } }),
      prisma.invoiceDetails.findMany({ where, select: { productId: true, salesQuantity: true, returnedQuantity: true, invoice: { select: { soldDate: true } } } }),
    ]);
    const stockDate = new Map(stocks.map((s) => [s.id, s.date]));
    const todayD = dayjs().startOf("day");

    const lastSale = {};
    sales.forEach((d) => {
      if (!(d.salesQuantity - d.returnedQuantity > 0)) return;
      const day = ymd(d.invoice.soldDate);
      if (!lastSale[d.productId] || day > lastSale[d.productId]) lastSale[d.productId] = day;
    });

    const P = {};
    lots.forEach((l) => {
      const p = (P[l.productId] ||= { productId: l.productId, inStore: 0, withSr: 0, value: 0, firstReceived: null, lastReceived: null, skus: new Set() });
      const received = stockDate.get(l.rootStockId || l.stockId) || l.date;
      if (l.stockId && (!p.lastReceived || received > p.lastReceived)) p.lastReceived = received;
      if (!p.firstReceived || received < p.firstReceived) p.firstReceived = received;
      const av = lotAvailable(l);
      if (av + l.issuedQuantity > 0) p.skus.add(l.stockSummaryId);
      p.inStore += av;
      p.withSr += l.issuedQuantity;
      p.value += (av + l.issuedQuantity) * l.purchasePrice;
    });

    const rows = Object.values(P)
      .filter((p) => p.inStore + p.withSr > 0.0005)
      .map((p) => {
        const last = lastSale[p.productId] || null;
        const since = last || p.firstReceived;
        const idleDays = since ? todayD.diff(dayjs(since), "day") : null;
        return {
          productId: p.productId,
          productCode: L.products.get(p.productId)?.code,
          ...L.pInfo(p.productId),
          skus: [...p.skus].map((id) => ({ sku: L.skuCode(id), sellingPrice: L.skus.get(id)?.sellingPrice, discount: !!L.skus.get(id)?.discountId })),
          lastSale: last,
          daysSinceSale: last ? todayD.diff(dayjs(last), "day") : null,
          neverSold: !last,
          firstReceived: p.firstReceived,
          lastReceived: p.lastReceived,
          idleDays,
          inStore: r3(p.inStore),
          withSr: r3(p.withSr),
          qty: r3(p.inStore + p.withSr),
          value: r2(p.value),
        };
      })
      .filter((x) => x.idleDays !== null && x.idleDays >= days)
      .sort((a, b) => b.idleDays - a.idleDays || b.value - a.value);
    return ok(res, { days, rows, totals: { products: rows.length, value: r2(rows.reduce((a, x) => a + x.value, 0)), neverSold: rows.filter((x) => x.neverSold).length } });
  } catch (error) {
    logger.error(`Dead stock report error: ${error.message}`);
    next(error);
  }
};

/* ------------------------------------------------------------------ */
/* 6. Purchases                                                        */
/* ------------------------------------------------------------------ */

/**
 * Stock entries dated in the range with the same totals as the stock list and supplier dues
 * (paid / returned are as of now), and a product-wise summary of what was received.
 */
exports.getPurchaseReport = async (req, res, next) => {
  try {
    const P = periodOf(req);
    const storeId = req.storeId;
    const [stocks, suppliers, L] = await Promise.all([
      prisma.stock.findMany({ where: { storeId, date: { gte: P.dFrom, lte: P.dTo } } }),
      prisma.supplier.findMany({ where: { storeId }, select: { id: true, name: true } }),
      loadLookups(prisma, storeId),
    ]);
    const ids = stocks.map((s) => s.id);
    const [lots, payments] = ids.length
      ? await Promise.all([
          prisma.stockDetails.findMany({ where: { storeId, rootStockId: { in: ids } } }),
          prisma.supplierPayment.findMany({ where: { storeId, stockId: { in: ids } } }),
        ])
      : [[], []];
    const returns = lots.length
      ? await prisma.stockAdjustment.findMany({ where: { storeId, adjustmentType: "supplier_return", stockDetailsId: { in: lots.map((l) => l.id) } } })
      : [];
    const S = indexBy(suppliers);
    const lotsOf = new Map(ids.map((id) => [id, []]));
    lots.forEach((l) => lotsOf.get(l.rootStockId)?.push(l));

    const prod = {};
    const entries = stocks
      .map((s) => {
        const entryLots = lotsOf.get(s.id) || [];
        const lotIds = new Set(entryLots.map((l) => l.id));
        const t = stockTotalsFrom({ stock: s, entryLots, payments: payments.filter((p) => p.stockId === s.id), returns: returns.filter((a) => lotIds.has(a.stockDetailsId)) });
        let qty = 0;
        entryLots
          .filter((l) => l.stockId === s.id)
          .forEach((l) => {
            const q = l.quantity + splitOutQty(l, entryLots);
            qty += q;
            const p = (prod[l.productId] ||= { productId: l.productId, qty: 0, value: 0, vat: 0, entries: new Set() });
            p.qty += q;
            p.value += q * l.purchasePrice;
            p.vat += (q * l.purchasePrice * (s.vatPercent || 0)) / 100;
            p.entries.add(s.id);
          });
        return {
          id: s.id,
          code: s.code,
          date: s.date,
          supplierId: s.supplierId,
          supplier: s.supplierId ? S.get(s.supplierId)?.name || "—" : null,
          supplierRefNo: s.supplierRefNo,
          remark: s.remark,
          vatPercent: s.vatPercent,
          items: t.lines,
          qty: r3(qty),
          subtotal: t.subtotal,
          vat: t.vat,
          total: t.total,
          paid: t.paid,
          returned: t.returned,
          due: t.due,
        };
      })
      .sort((a, b) => b.date.localeCompare(a.date) || b.code.localeCompare(a.code));

    const products = Object.values(prod)
      .map((p) => ({
        productId: p.productId,
        productCode: L.products.get(p.productId)?.code,
        ...L.pInfo(p.productId),
        qty: r3(p.qty),
        value: r2(p.value),
        vat: r2(p.vat),
        total: r2(p.value + p.vat),
        avgCost: p.qty ? r2(p.value / p.qty) : 0,
        entries: p.entries.size,
      }))
      .sort((a, b) => b.value - a.value);
    const sumK = (k) => r2(entries.reduce((a, x) => a + x[k], 0));
    const totals = { entries: entries.length, subtotal: sumK("subtotal"), vat: sumK("vat"), total: sumK("total"), paid: sumK("paid"), returned: sumK("returned"), due: sumK("due") };
    return ok(res, { from: P.from, to: P.to, entries, products, totals });
  } catch (error) {
    logger.error(`Purchase report error: ${error.message}`);
    next(error);
  }
};

/* ------------------------------------------------------------------ */
/* 7. VAT                                                              */
/* ------------------------------------------------------------------ */

/**
 * Output VAT (sales, less the VAT share of customer returns) and input VAT (stock entries, less the
 * VAT share of returns to suppliers), per day, plus a sales and a purchase register.
 * A customer return takes back its share of the invoice VAT (return amount / invoice line total).
 * A supplier return takes back its value × the stock entry's VAT %.
 */
exports.getVatReport = async (req, res, next) => {
  try {
    const P = periodOf(req);
    const storeId = req.storeId;
    const [L, invoices, returns, stocks, suppliers, supReturns] = await Promise.all([
      loadLookups(prisma, storeId),
      prisma.salesInvoice.findMany({ where: { storeId, soldDate: { gte: P.gte, lte: P.lte } }, orderBy: { soldDate: "asc" } }),
      prisma.salesReturn.findMany({ where: { storeId, returnDate: { gte: P.gte, lte: P.lte } }, orderBy: { returnDate: "asc" } }),
      prisma.stock.findMany({ where: { storeId, date: { gte: P.dFrom, lte: P.dTo } }, orderBy: [{ date: "asc" }, { code: "asc" }] }),
      prisma.supplier.findMany({ where: { storeId }, select: { id: true, name: true } }),
      prisma.stockAdjustment.findMany({ where: { storeId, adjustmentType: "supplier_return", date: { gte: P.dFrom, lte: P.dTo } }, orderBy: { date: "asc" } }),
    ]);
    const S = indexBy(suppliers);

    // invoices of the returns (may be sold before the range) with their line totals
    const retInvIds = [...new Set(returns.map((r) => r.invoiceId))];
    const retInvoices = retInvIds.length
      ? await prisma.salesInvoice.findMany({ where: { storeId, id: { in: retInvIds } }, include: { details: { select: { total: true } } } })
      : [];
    const RI = indexBy(retInvoices);

    // stock entries: value and VAT
    const stockIds = stocks.map((s) => s.id);
    const entryLots = stockIds.length ? await prisma.stockDetails.findMany({ where: { storeId, rootStockId: { in: stockIds } } }) : [];
    const lotsOf = new Map(stockIds.map((id) => [id, []]));
    entryLots.forEach((l) => lotsOf.get(l.rootStockId)?.push(l));

    // supplier returns: VAT % of the entry the lot came from
    const srLots = supReturns.length
      ? await prisma.stockDetails.findMany({ where: { storeId, id: { in: supReturns.map((a) => a.stockDetailsId) } }, select: { id: true, rootStockId: true, stockId: true } })
      : [];
    const SRL = indexBy(srLots);
    const srStocks = srLots.length
      ? await prisma.stock.findMany({ where: { storeId, id: { in: [...new Set(srLots.map((l) => l.rootStockId || l.stockId).filter(Boolean))] } }, select: { id: true, code: true, vatPercent: true, supplierId: true } })
      : [];
    const SRS = indexBy(srStocks);

    const days = {};
    const day = (d) =>
      (days[d] ||= { date: d, invoices: 0, salesValue: 0, outputVat: 0, returnValue: 0, returnVat: 0, purchaseValue: 0, inputVat: 0, supplierReturnValue: 0, supplierReturnVat: 0 });

    const salesRegister = [];
    invoices.forEach((inv) => {
      const taxable = r2(Math.max(0, inv.subtotal - inv.totalDiscount));
      const d = day(ymd(inv.soldDate));
      d.invoices += 1;
      d.salesValue += taxable;
      d.outputVat += inv.vatAmount;
      salesRegister.push({
        key: `inv:${inv.id}`,
        type: "invoice",
        date: inv.soldDate,
        ref: inv.invoiceNo,
        customer: L.cName(inv.soldToId),
        channel: inv.channel,
        vatPercent: inv.vatPercent,
        value: taxable,
        vat: inv.vatAmount,
        total: r2(taxable + inv.vatAmount),
      });
    });
    returns.forEach((r) => {
      const inv = RI.get(r.invoiceId);
      if (!inv) return;
      // a return refunds its share of what was paid (bill discount taken off, VAT added), so its
      // part of the invoice is return amount ÷ invoice total
      const share = inv.totalAmount ? r.totalAmount / inv.totalAmount : 0;
      const value = r2(Math.max(0, inv.subtotal - inv.totalDiscount) * share);
      const vat = r2(inv.vatAmount * share);
      const d = day(ymd(r.returnDate));
      d.returnValue += value;
      d.returnVat += vat;
      salesRegister.push({
        key: `ret:${r.id}`,
        type: "return",
        date: r.returnDate,
        ref: r.returnNo,
        invoiceNo: inv.invoiceNo,
        customer: L.cName(inv.soldToId),
        channel: inv.channel,
        vatPercent: inv.vatPercent,
        value: -value,
        vat: -vat,
        total: r2(-(value + vat)),
      });
    });

    const purchaseRegister = [];
    stocks.forEach((s) => {
      const t = stockTotalsFrom({ stock: s, entryLots: lotsOf.get(s.id) || [], payments: [], returns: [] });
      const d = day(s.date);
      d.purchaseValue += t.subtotal;
      d.inputVat += t.vat;
      purchaseRegister.push({
        key: `st:${s.id}`,
        type: "purchase",
        date: s.date,
        ref: s.code,
        supplierRefNo: s.supplierRefNo,
        supplier: s.supplierId ? S.get(s.supplierId)?.name || "—" : null,
        vatPercent: s.vatPercent,
        value: t.subtotal,
        vat: t.vat,
        total: t.total,
      });
    });
    const srRef = {};
    supReturns.forEach((a) => {
      const lot = SRL.get(a.stockDetailsId);
      const st = SRS.get(lot?.rootStockId || lot?.stockId);
      const vatPercent = st?.vatPercent || 0;
      const vat = (a.amount * vatPercent) / 100;
      const d = day(a.date);
      d.supplierReturnValue += a.amount;
      d.supplierReturnVat += vat;
      const k = `sret:${a.refNo || a.id}:${st?.id || ""}`;
      srRef[k] ||= {
        key: k,
        type: "supplier_return",
        date: a.date,
        ref: a.refNo,
        stockCode: st?.code || null,
        supplier: a.supplierId ? S.get(a.supplierId)?.name || "—" : null,
        vatPercent,
        value: 0,
        vat: 0,
        total: 0,
      };
      srRef[k].value -= a.amount;
      srRef[k].vat -= vat;
    });
    Object.values(srRef).forEach((x) => purchaseRegister.push({ ...x, value: r2(x.value), vat: r2(x.vat), total: r2(x.value + x.vat) }));

    const daily = Object.values(days)
      .map((d) => {
        const x = Object.fromEntries(Object.entries(d).map(([k, v]) => [k, typeof v === "number" && k !== "invoices" ? r2(v) : v]));
        x.netVat = r2(x.outputVat - x.returnVat - (x.inputVat - x.supplierReturnVat));
        return x;
      })
      .sort((a, b) => a.date.localeCompare(b.date));
    const sumK = (k) => r2(daily.reduce((a, x) => a + x[k], 0));
    const summary = {
      invoices: invoices.length,
      salesValue: sumK("salesValue"),
      outputVat: sumK("outputVat"),
      returnValue: sumK("returnValue"),
      returnVat: sumK("returnVat"),
      purchaseValue: sumK("purchaseValue"),
      inputVat: sumK("inputVat"),
      supplierReturnValue: sumK("supplierReturnValue"),
      supplierReturnVat: sumK("supplierReturnVat"),
    };
    summary.netOutputVat = r2(summary.outputVat - summary.returnVat);
    summary.netInputVat = r2(summary.inputVat - summary.supplierReturnVat);
    summary.netVat = r2(summary.netOutputVat - summary.netInputVat);
    const byDate = (a, b) => String(a.date).localeCompare(String(b.date)) || String(a.ref).localeCompare(String(b.ref));
    return ok(res, {
      from: P.from,
      to: P.to,
      summary,
      daily,
      salesRegister: salesRegister.sort(byDate),
      purchaseRegister: purchaseRegister.sort(byDate),
    });
  } catch (error) {
    logger.error(`VAT report error: ${error.message}`);
    next(error);
  }
};
