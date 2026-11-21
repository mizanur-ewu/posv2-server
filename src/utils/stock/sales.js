const dayjs = require("dayjs");
const { r2, r3, toDate, ymd } = require("../helperFunction");
const { fail, lotAvailable, allocate, nextNo } = require("./stockWork");
const { takeSerials, markSold, backInStock } = require("./serials");

const recalcDue = (inv) => r2(inv.totalAmount - inv.returnedAmount - (inv.totalPaid - inv.refundedAmount));

const checkMethods = async (tx, ids) => {
  const list = [...new Set(ids.filter(Boolean))];
  if (!list.length) return;
  const found = await tx.paymentMethod.count({ where: { id: { in: list } } });
  if (found !== list.length) fail("Select a payment method");
};

/* ------------------------------------------------------------------ */
/* Sales invoice                                                       */
/* ------------------------------------------------------------------ */

/**
 * Create a sales invoice (POS, SR sale or delivery).
 * Every SKU line is allocated to lots FEFO → FIFO before anything changes (all or nothing).
 * One InvoiceDetails row per lot, with the lot's exact purchase price.
 * With issueId the goods come from that sales out's lots (issued → sold).
 */
const createInvoice = async (work, payload) => {
  const { tx, ctx } = work;
  const {
    channel = "pos",
    soldToId = null,
    srId = null,
    deliveryManId = null,
    issueId = null,
    salesOrderId = null,
    lines = [],
    billDiscount = 0,
    voucherAmount = 0,
    vatPercent = 0,
    payments = [],
    soldDate,
    remark = "",
    viaApp = false,
    fromSettlement = false,
  } = payload;

  if (!lines.length) fail("Invoice has no lines");
  const issue = issueId ? await work.loadIssue(issueId) : null;
  if (issueId && !issue) fail("Issue not found");
  if (issue && issue.status !== "open") fail("Issue is already settled");
  if (soldToId && !(await tx.customer.findFirst({ where: { ...work.where, id: soldToId }, select: { id: true } }))) {
    fail("Customer not found");
  }
  await checkMethods(tx, payments.filter((p) => Number(p.amount) > 0).map((p) => p.paymentMethodId));
  await work.loadProducts();
  await work.loadSkus(lines.map((l) => l.skuId));

  // 1) allocate every SKU line before touching anything
  const pending = new Map();
  const plan = lines.map((ln) => {
    const sku = work.sku(ln.skuId);
    if (!sku) fail("SKU not found");
    if (!(Number(ln.quantity) > 0)) fail(`${work.pName(sku.productId)}: quantity must be greater than 0`);
    if (ln.unitPrice !== undefined && ln.unitPrice !== null && !(Number(ln.unitPrice) >= 0)) fail("Price can't be negative");
    let picks;
    if (issue) {
      const dets = issue.details.filter((d) => d.stockSummaryId === sku.id);
      picks = allocate(
        dets.map((d) => ({ ...work.lot(d.stockDetailsId), _det: d })),
        ln.quantity,
        (l) => r3(l._det.issuedQuantity - l._det.soldQuantity - l._det.returnedQuantity - l._det.shortQuantity - (pending.get(l._det.id) || 0)),
      );
      if (picks) picks.forEach((p) => pending.set(p.lot._det.id, r3((pending.get(p.lot._det.id) || 0) + p.q)));
    } else {
      const lots = work.skuLots(sku.id).filter((l) => l.status === "active");
      picks = allocate(lots, ln.quantity, (l) => r3(lotAvailable(l) - (pending.get(l.id) || 0)));
      if (picks) picks.forEach((p) => pending.set(p.lot.id, r3((pending.get(p.lot.id) || 0) + p.q)));
    }
    if (!picks) fail(`Not enough stock for ${work.pName(sku.productId)} @ ${sku.sellingPrice}`);
    return { ln, sku, picks };
  });

  // IMEI / serial products: the units sold are named on the line
  const serialRows = [];
  for (const { ln, sku } of plan) {
    const product = work.product(sku.productId);
    if (!product?.trackSerial) continue;
    if (issue) fail(`${work.pName(product.id)} has IMEI / serial numbers: sell it from POS, not through a sales out`);
    const rows = await takeSerials(tx, ctx, { product: { ...product, name: work.pName(product.id) }, serials: ln.serials, quantity: ln.quantity });
    serialRows.push({ rows, product });
  }

  // 2) build invoice lines and move the stock
  const details = [];
  let subtotal = 0;
  let lineDiscounts = 0;
  plan.forEach(({ ln, sku, picks }) => {
    const unitPrice = r2(ln.unitPrice ?? sku.sellingPrice);
    const lineQty = r3(ln.quantity);
    const lineDiscount = r2(ln.discount || 0);
    let discLeft = lineDiscount;
    picks.forEach((p, idx) => {
      const lot = work.lot(p.lot.id);
      const share = idx === picks.length - 1 ? discLeft : r2((lineDiscount * p.q) / lineQty);
      discLeft = r2(discLeft - share);
      const gross = r2(p.q * unitPrice);
      details.push({
        ...work.tenant,
        stockDetailsId: lot.id,
        stockSummaryId: sku.id,
        productId: sku.productId,
        salesQuantity: p.q,
        unitPrice,
        purchasePrice: lot.purchasePrice,
        discountAmount: share,
        total: r2(gross - share),
        returnedQuantity: 0,
      });
      subtotal += gross;
      lineDiscounts += share;
      if (issue) {
        p.lot._det.soldQuantity = r3(p.lot._det.soldQuantity + p.q);
        lot.issuedQuantity = r3(lot.issuedQuantity - p.q);
      }
      lot.soldQuantity = r3(lot.soldQuantity + p.q);
    });
    work.recalc(sku.id);
  });

  const when = soldDate ? dayjs(soldDate) : dayjs();
  const inv = {
    subtotal: r2(subtotal),
    vatPercent: Number(vatPercent) || 0,
    voucherAmount: r2(voucherAmount),
    returnedAmount: 0,
    refundedAmount: 0,
  };
  inv.totalDiscount = r2(lineDiscounts + Number(billDiscount || 0) + Number(voucherAmount || 0));
  const taxable = Math.max(0, inv.subtotal - inv.totalDiscount);
  inv.vatAmount = r2((taxable * inv.vatPercent) / 100);
  inv.totalAmount = r2(taxable + inv.vatAmount);

  const paidTotal = r2(payments.reduce((a, p) => a + (Number(p.amount) || 0), 0));
  if (channel === "pos" && !soldToId && paidTotal + 0.001 < inv.totalAmount) fail("Walk-in customer must pay the full amount");

  let toApply = Math.min(paidTotal, inv.totalAmount);
  const paymentRows = [];
  payments.forEach((p) => {
    const amt = r2(Math.min(Number(p.amount) || 0, toApply));
    toApply = r2(toApply - amt);
    if (amt > 0) {
      paymentRows.push({
        ...work.tenant,
        customerId: soldToId,
        issueId,
        amount: amt,
        paymentMethodId: p.paymentMethodId,
        date: toDate(when),
        createdById: ctx.userId,
      });
    }
  });
  inv.totalPaid = r2(paymentRows.reduce((a, p) => a + p.amount, 0));
  inv.changeReturned = r2(Math.max(0, paidTotal - inv.totalAmount));
  inv.totalDue = recalcDue(inv);

  const created = await tx.salesInvoice.create({
    data: {
      ...work.tenant,
      ...inv,
      invoiceNo: await nextNo(tx, ctx, "SI"),
      channel,
      soldById: ctx.userId,
      soldToId,
      srId,
      deliveryManId,
      issueId,
      salesOrderId,
      soldDate: when.toISOString(),
      remark: remark || "",
      viaApp,
      fromSettlement,
      details: { create: details },
      payments: { create: paymentRows },
    },
    include: { details: { orderBy: { line: "asc" } }, payments: { orderBy: { line: "asc" } } },
  });
  for (const { rows, product } of serialRows) {
    await markSold(tx, rows, { invoiceId: created.id, customerId: soldToId, soldAt: when, warrantyMonths: product.warrantyMonths || 0 });
  }
  return created;
};

/** Due paid after the sale. `collectionId` groups the invoices one due collection paid off. */
const receivePayment = async (tx, ctx, invoiceId, { amount, paymentMethodId, date, remark, collectionId }) => {
  const inv = await tx.salesInvoice.findFirst({ where: { storeId: ctx.storeId, id: invoiceId } });
  if (!inv) fail("Invoice not found");
  const amt = r2(Number(amount) || 0);
  if (!(amt > 0)) fail("Enter an amount");
  if (amt > inv.totalDue + 0.001) fail("Amount is more than due");
  await checkMethods(tx, [paymentMethodId || "x"]);
  await tx.customerPayment.create({
    data: {
      storeId: ctx.storeId,
      companyId: ctx.companyId,
      customerId: inv.soldToId,
      salesInvoiceId: inv.id,
      issueId: null,
      amount: amt,
      paymentMethodId,
      date: toDate(date || dayjs()),
      createdById: ctx.userId,
      dueCollection: true,
      collectionId: collectionId || null,
      remark: remark || null,
    },
  });
  const totalPaid = r2(inv.totalPaid + amt);
  return tx.salesInvoice.update({
    where: { id: inv.id },
    data: { totalPaid, totalDue: recalcDue({ ...inv, totalPaid }) },
  });
};

/** Why an invoice can't be deleted, or null. SR sale / delivery invoices belong to a sales out. */
const invoiceDeleteBlockReason = (inv, { issueNo, orderNo } = {}) => {
  if (inv.issueId) return `Part of a Sales Out${issueNo ? ` (${issueNo})` : ""}. Change it from its Sales Return instead.`;
  if (inv.salesOrderId) return `Delivery of a sales order${orderNo ? ` (${orderNo})` : ""}. Change it from the order instead.`;
  if (inv.channel !== "pos") return "Only POS sales can be deleted";
  return null;
};

/**
 * Delete a POS sale for good. What is still sold goes back to the same lots; its payments and
 * customer returns go with it.
 */
const deleteInvoice = async (work, invoiceId) => {
  const { tx } = work;
  const inv = await tx.salesInvoice.findFirst({ where: { ...work.where, id: invoiceId }, include: { details: true } });
  if (!inv) fail("Invoice not found");
  const reason = invoiceDeleteBlockReason(inv);
  if (reason) fail(`${inv.invoiceNo}: ${reason}`);
  await work.loadLots(inv.details.map((d) => d.stockDetailsId));
  inv.details.forEach((d) => {
    const lot = work.lot(d.stockDetailsId);
    // returned qty is already back in the lot
    if (lot) lot.soldQuantity = r3(Math.max(0, lot.soldQuantity - (d.salesQuantity - d.returnedQuantity)));
    work.recalc(d.stockSummaryId);
  });
  const returns = await tx.salesReturn.count({ where: { ...work.where, invoiceId } });
  await backInStock(tx, { ...work.where, invoiceId, status: "sold" });
  await tx.salesInvoice.delete({ where: { id: invoiceId } }); // details, payments and returns cascade
  return { id: inv.id, invoiceNo: inv.invoiceNo, returns };
};

/* ------------------------------------------------------------------ */
/* Customer return                                                     */
/* ------------------------------------------------------------------ */

/**
 * A return is made against invoice lines. Stock goes back to the SAME lot. The amount is
 * adjusted against the invoice due first, the rest is refunded.
 */
const createReturn = async (work, { invoiceId, lines = [], paymentMethodId, reason }) => {
  const { tx, ctx } = work;
  const inv = await tx.salesInvoice.findFirst({ where: { ...work.where, id: invoiceId }, include: { details: true } });
  if (!inv) fail("Invoice not found");
  const valid = lines.filter((l) => Number(l.quantity) > 0);
  if (!valid.length) fail("Enter return quantity for at least one line");
  if (paymentMethodId) await checkMethods(tx, [paymentMethodId]);
  await work.loadLots(inv.details.map((d) => d.stockDetailsId));
  await work.loadProducts();
  const returnedSerials = [];

  const rows = [];
  let total = 0;
  // the invoice total spread over its lines: bill discount / voucher taken off, VAT added
  const lineSum = inv.details.reduce((a, d) => a + d.total, 0);
  const payFactor = lineSum > 0 ? inv.totalAmount / lineSum : 0;
  for (const l of valid) {
    const d = inv.details.find((x) => x.id === l.invoiceDetailsId);
    if (!d) fail("Invoice line not found");
    const q = r3(l.quantity);
    const left = r3(d.salesQuantity - d.returnedQuantity);
    if (q > left + 0.0005) fail("Return qty is more than sold qty");
    const product = work.product(d.productId);
    if (product?.trackSerial) {
      const list = (Array.isArray(l.serials) ? l.serials : []).map((s) => String(s).trim()).filter(Boolean);
      if (list.length !== q) fail(`${work.pName(d.productId)}: choose the ${q} IMEI / serial number(s) that came back`);
      const rows = await tx.serialNumber.findMany({ where: { ...work.where, invoiceId: inv.id, productId: d.productId, status: "sold", serial: { in: list, mode: "insensitive" } } });
      if (rows.length !== list.length) fail(`${work.pName(d.productId)}: an IMEI / serial was not sold on this invoice`);
      returnedSerials.push(...rows.map((r) => r.id));
    }
    const amount = r2((d.total / d.salesQuantity) * q * payFactor);
    const lot = work.lot(d.stockDetailsId);
    lot.soldQuantity = r3(lot.soldQuantity - q); // back to the same lot
    d.returnedQuantity = r3(d.returnedQuantity + q);
    await tx.invoiceDetails.update({ where: { id: d.id }, data: { returnedQuantity: d.returnedQuantity } });
    work.recalc(d.stockSummaryId);
    rows.push({
      ...work.tenant,
      invoiceDetailsId: d.id,
      stockDetailsId: d.stockDetailsId,
      stockSummaryId: d.stockSummaryId,
      productId: d.productId,
      returnQuantity: q,
      amount,
    });
    total += amount;
  }

  if (returnedSerials.length) await backInStock(tx, { id: { in: returnedSerials } });

  // never more than what is left of the invoice (rounding of the last unit)
  const totalAmount = r2(Math.min(total, inv.totalAmount - inv.returnedAmount));
  const dueBefore = Math.max(0, inv.totalDue);
  const dueAdjusted = r2(Math.min(dueBefore, totalAmount));
  const refundAmount = r2(totalAmount - dueAdjusted);
  const returnedAmount = r2(inv.returnedAmount + totalAmount);
  const refundedAmount = r2(inv.refundedAmount + refundAmount);
  await tx.salesInvoice.update({
    where: { id: inv.id },
    data: { returnedAmount, refundedAmount, totalDue: recalcDue({ ...inv, returnedAmount, refundedAmount }) },
  });

  return tx.salesReturn.create({
    data: {
      ...work.tenant,
      returnNo: await nextNo(tx, ctx, "SR"),
      invoiceId,
      customerId: inv.soldToId,
      totalAmount,
      dueAdjusted,
      refundAmount,
      paymentMethodId: paymentMethodId || null,
      reason: reason || "",
      returnDate: new Date().toISOString(),
      createdById: ctx.userId,
      details: { create: rows },
    },
    include: { details: true },
  });
};

module.exports = {
  recalcDue,
  createInvoice,
  receivePayment,
  invoiceDeleteBlockReason,
  deleteInvoice,
  createReturn,
  ymd,
};
