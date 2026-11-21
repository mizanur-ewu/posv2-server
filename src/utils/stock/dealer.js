const dayjs = require("dayjs");
const { r2, r3, toDate } = require("../helperFunction");
const { CASH } = require("./constants");
const { fail, lotAvailable, fefoFifo, allocate, nextNo } = require("./stockWork");
const { createInvoice } = require("./sales");

/* ------------------------------------------------------------------ */
/* Product issue (sales out)                                           */
/* ------------------------------------------------------------------ */

/** Per SKU totals of an issue. */
const issueSkuSummary = (details) => {
  const map = {};
  details.forEach((d) => {
    const m = (map[d.stockSummaryId] ||= { skuId: d.stockSummaryId, productId: d.productId, issued: 0, sold: 0, returned: 0, short: 0 });
    m.issued = r3(m.issued + d.issuedQuantity);
    m.sold = r3(m.sold + d.soldQuantity);
    m.returned = r3(m.returned + d.returnedQuantity);
    m.short = r3(m.short + d.shortQuantity);
  });
  return Object.values(map).map((m) => ({ ...m, remaining: r3(m.issued - m.sold - m.returned - m.short) }));
};

/**
 * Give products to an SR / delivery man. Lots are picked FEFO → FIFO, one detail per lot,
 * and their issuedQuantity goes up (available stock goes down). Selected pending orders go out with it.
 */
/** IMEI / serial products don't go through sales orders and sales outs (they are sold from POS). */
const blockSerialSkus = async (tx, where, skuIds) => {
  if (!skuIds.length) return;
  const hit = await tx.stockSummary.findFirst({
    where: { ...where, id: { in: skuIds }, product: { trackSerial: true } },
    select: { product: { select: { name: true, variantName: true } } },
  });
  if (hit) {
    const p = hit.product;
    fail(`${p.variantName ? `${p.name} (${p.variantName})` : p.name} has IMEI / serial numbers: sell it from POS, not through orders or sales out`);
  }
};

const createIssue = async (work, { type, employeeId, date, lines = [], orderIds = [] }) => {
  const { tx, ctx } = work;
  if (!["sr_sale", "delivery"].includes(type)) fail("Select the sales out type");
  const emp = await tx.employee.findFirst({ where: { ...work.where, id: employeeId || "" } });
  if (!emp) fail("Select an employee");
  if (emp.status !== "active") fail(`${emp.name} is inactive`);

  // one line per SKU
  const merged = {};
  lines
    .filter((l) => Number(l.quantity) > 0)
    .forEach((l) => {
      merged[l.skuId] = r3((merged[l.skuId] || 0) + Number(l.quantity));
    });
  const valid = Object.entries(merged).map(([skuId, quantity]) => ({ skuId, quantity }));
  if (!valid.length) fail("Add at least one SKU line");
  await blockSerialSkus(tx, work.where, valid.map((v) => v.skuId));

  // only orders waiting for delivery can go out; a closed / delivered / on-trip order's cycle is over or running
  const orders = orderIds.length ? await tx.salesOrder.findMany({ where: { ...work.where, id: { in: orderIds } } }) : [];
  orderIds.forEach((oid) => {
    const o = orders.find((x) => x.id === oid);
    if (!o) fail("Order not found");
    if (o.status !== "pending" || o.issueId) {
      fail(`Order ${o.orderNo} is ${o.status === "closed" ? "closed by its sales return" : o.status} and cannot go out again`);
    }
  });

  await work.loadProducts();
  await work.loadSkus(valid.map((l) => l.skuId));
  const plans = valid.map((ln) => {
    const sku = work.sku(ln.skuId);
    if (!sku) fail("SKU not found");
    const picks = allocate(work.skuLots(ln.skuId).filter((l) => l.status === "active"), ln.quantity, lotAvailable);
    if (!picks) fail(`Not enough stock for ${work.pName(sku.productId)} @ ${sku.sellingPrice}`);
    return { ln, picks };
  });

  const details = [];
  plans.forEach(({ ln, picks }) => {
    picks.forEach(({ lot, q }) => {
      lot.issuedQuantity = r3(lot.issuedQuantity + q);
      details.push({
        ...work.tenant,
        stockDetailsId: lot.id,
        stockSummaryId: lot.stockSummaryId,
        productId: lot.productId,
        issuedQuantity: q,
      });
    });
    work.recalc(ln.skuId);
  });

  const issue = await tx.productIssue.create({
    data: {
      ...work.tenant,
      issueNo: await nextNo(tx, ctx, "IS"),
      type,
      employeeId,
      date: toDate(date),
      status: "open",
      issuedById: ctx.userId,
      details: { create: details },
    },
    include: { details: { orderBy: { line: "asc" } }, expenses: true },
  });

  for (const o of orders) {
    await tx.salesOrder.update({
      where: { id: o.id },
      data: { status: "issued", issueId: issue.id, deliveryManId: employeeId, issueHistory: { push: issue.id } },
    });
  }
  if (orders.length && emp.userId) {
    await tx.notification.create({
      data: {
        ...work.tenant,
        userId: emp.userId,
        type: "delivery_assigned",
        refType: "ProductIssue",
        refId: issue.id,
        message: `${orders.length} order(s) assigned to you on ${issue.issueNo}`,
      },
    });
  }
  return issue;
};

/* ------------------------------------------------------------------ */
/* Delivery (order → invoice)                                          */
/* ------------------------------------------------------------------ */

/** Status of an order from its delivered quantities. Nothing delivered: it stays on its trip. */
const deliveredStatus = (details) => {
  const allDone = details.every((d) => d.deliveredQuantity >= d.quantity - 0.0005);
  const any = details.some((d) => d.deliveredQuantity > 0);
  return allDone ? "delivered" : any ? "partial" : "issued";
};

const deliverOrder = async (work, orderId, { lines = [], collected = 0, paymentMethodId = CASH, date, viaApp = false, fromSettlement = false }) => {
  const { tx } = work;
  const o = await tx.salesOrder.findFirst({
    where: { ...work.where, id: orderId },
    include: { details: { orderBy: { line: "asc" } } },
  });
  if (!o) fail("Order not found");
  if (!o.issueId) fail("Order is not issued yet");
  const invLines = [];
  lines.forEach((l) => {
    const d = o.details.find((x) => x.id === l.orderDetailId);
    const qty = Number(l.deliveredQty) || 0;
    if (!d || !(qty > 0)) return;
    const left = r3(d.quantity - d.deliveredQuantity);
    if (qty > left + 0.0005) fail("Delivered qty is more than ordered");
    invLines.push({ skuId: d.stockSummaryId, quantity: qty, unitPrice: d.unitPrice, _d: d });
  });

  let invoice = null;
  if (invLines.length) {
    invoice = await createInvoice(work, {
      channel: "delivery",
      soldToId: o.customerId,
      srId: o.srId,
      deliveryManId: o.deliveryManId,
      issueId: o.issueId,
      salesOrderId: o.id,
      lines: invLines.map(({ _d, ...l }) => l),
      payments: Number(collected) > 0 ? [{ paymentMethodId: paymentMethodId || CASH, amount: Number(collected) }] : [],
      soldDate: date,
      remark: viaApp ? "Delivered via mobile app" : "",
      viaApp,
      fromSettlement,
    });
    for (const l of invLines) {
      l._d.deliveredQuantity = r3(l._d.deliveredQuantity + l.quantity);
      await tx.salesOrderDetails.update({ where: { id: l._d.id }, data: { deliveredQuantity: l._d.deliveredQuantity } });
    }
  }
  // nothing delivered: the order stays on its trip – the trip's sales return closes it
  await tx.salesOrder.update({ where: { id: o.id }, data: { status: deliveredStatus(o.details) } });
  return invoice;
};

/* ------------------------------------------------------------------ */
/* Day-end settlement (sales return)                                   */
/* ------------------------------------------------------------------ */

const settleIssue = async (work, issueId, { returns = {}, invoices = [], deliveries = [], expenses = [], cashDeposited = 0, date }) => {
  const { tx, ctx } = work;
  const issue = await work.loadIssue(issueId);
  if (!issue) fail("Issue not found");
  if (issue.status !== "open") fail("Issue is already settled");
  await work.loadProducts();

  // validation: invoiced qty per SKU must not exceed issued − returned
  const summary = issueSkuSummary(issue.details);
  const newQty = {};
  invoices.forEach((inv) =>
    (inv.lines || []).forEach((l) => {
      newQty[l.skuId] = r3((newQty[l.skuId] || 0) + (Number(l.quantity) || 0));
    }),
  );
  for (const dv of deliveries) {
    const o = await tx.salesOrder.findFirst({ where: { ...work.where, id: dv.orderId }, include: { details: true } });
    if (!o) fail("Order not found");
    if (o.issueId !== issueId) fail(`Order ${o.orderNo} is not on this sales out`);
    (dv.lines || []).forEach((l) => {
      const d = o.details.find((x) => x.id === l.orderDetailId);
      if (!d) fail("Order line not found");
      newQty[d.stockSummaryId] = r3((newQty[d.stockSummaryId] || 0) + (Number(l.deliveredQty) || 0));
    });
  }
  Object.keys(returns).forEach((skuId) => {
    if (!summary.some((s) => s.skuId === skuId)) fail("A returned SKU is not on this sales out");
  });
  summary.forEach((s) => {
    const ret = Number(returns[s.skuId] || 0);
    if (ret < 0) fail("Returned qty can't be negative");
    if (r3(s.sold + (newQty[s.skuId] || 0) + ret) > s.issued + 0.0005) fail(`${work.pName(s.productId)}: sold + returned is more than issued`);
  });

  const when = date ? dayjs(date) : dayjs();

  // 1) sales
  for (const inv of invoices) {
    await createInvoice(work, {
      channel: "sr_sale",
      soldToId: inv.customerId || null,
      srId: issue.employeeId,
      issueId,
      lines: (inv.lines || []).filter((l) => Number(l.quantity) > 0),
      payments: Number(inv.paid) > 0 ? [{ paymentMethodId: inv.paymentMethodId || CASH, amount: Number(inv.paid) }] : [],
      soldDate: when.toISOString(),
      remark: inv.customerId ? "" : "Consolidated SR sale",
      fromSettlement: true, // an edit / delete of this sales return finds what it created
    });
  }
  for (const dv of deliveries) {
    await deliverOrder(work, dv.orderId, { ...dv, date: when.toISOString(), viaApp: false, fromSettlement: true });
  }
  // the sales return ends every order on this trip: what was not delivered is not delivered later
  await tx.salesOrder.updateMany({
    where: { ...work.where, issueId, status: { in: ["issued", "partial"] } },
    data: { status: "closed", issueId: null, closedIssueId: issueId, closedAt: when.toISOString() },
  });

  // 2) returns go back to the same lots (latest-expiry lots first, mirror of FEFO picking)
  Object.entries(returns).forEach(([skuId, q]) => {
    let left = r3(Number(q) || 0);
    issue.details
      .filter((d) => d.stockSummaryId === skuId)
      .map((d) => ({ d, lot: work.lot(d.stockDetailsId) }))
      .sort((a, b) => fefoFifo(b.lot, a.lot))
      .forEach(({ d, lot }) => {
        if (left <= 0) return;
        const rem = r3(d.issuedQuantity - d.soldQuantity - d.returnedQuantity - d.shortQuantity);
        const x = Math.min(rem, left);
        if (x <= 0) return;
        d.returnedQuantity = r3(d.returnedQuantity + x);
        lot.issuedQuantity = r3(lot.issuedQuantity - x);
        left = r3(left - x);
      });
    work.recalc(skuId);
  });

  // 3) shortage: whatever is still outstanding is charged to the employee
  for (const d of issue.details) {
    const rem = r3(d.issuedQuantity - d.soldQuantity - d.returnedQuantity - d.shortQuantity);
    if (rem <= 0) continue;
    const lot = work.lot(d.stockDetailsId);
    d.shortQuantity = r3(d.shortQuantity + rem);
    lot.issuedQuantity = r3(lot.issuedQuantity - rem);
    lot.adjustQuantity = r3(lot.adjustQuantity + rem);
    await tx.stockAdjustment.create({
      data: {
        ...work.tenant,
        stockDetailsId: lot.id,
        stockSummaryId: d.stockSummaryId,
        adjustmentType: "shortage",
        direction: "out",
        quantity: rem,
        reason: "Settlement shortage – charged to employee",
        issueId,
        employeeId: issue.employeeId,
        amount: r2(rem * lot.sellingPrice),
        date: toDate(when),
        createdById: ctx.userId,
      },
    });
    work.recalc(d.stockSummaryId);
  }

  // 4) cash
  await tx.issueExpense.deleteMany({ where: { ...work.where, issueId } });
  const exp = expenses
    .filter((e) => Number(e.amount) > 0)
    .map((e) => ({ ...work.tenant, issueId, expenseHead: String(e.expenseHead || "Other"), amount: r2(e.amount), remark: e.remark || "" }));
  if (exp.length) await tx.issueExpense.createMany({ data: exp });
  const invs = await tx.salesInvoice.findMany({ where: { ...work.where, issueId }, include: { payments: true } });
  const totalSales = r2(invs.reduce((a, i) => a + i.totalAmount, 0));
  const cashCollected = r2(invs.reduce((a, i) => a + i.payments.filter((p) => p.issueId === issueId).reduce((x, p) => x + p.amount, 0), 0));
  const totalExpense = r2(exp.reduce((a, e) => a + e.amount, 0));
  const deposited = r2(cashDeposited);
  await work.updateIssue(issue, {
    totalSales,
    cashCollected,
    totalExpense,
    cashDeposited: deposited,
    cashShortExcess: r2(deposited - (cashCollected - totalExpense)),
    status: "settled",
    settledById: ctx.userId,
    settledAt: when.toISOString(),
  });
  issue.expenses = await tx.issueExpense.findMany({ where: { ...work.where, issueId } });
  return issue;
};

/**
 * Undo a day-end settlement: the invoices it created, its returns and its shortages are reversed,
 * trip orders go back on the sales out and the sales out is open again.
 */
const unsettleIssue = async (work, issueId, { checkStock = true } = {}) => {
  const { tx } = work;
  const issue = await work.loadIssue(issueId);
  if (!issue) fail("Sales out not found");
  if (issue.status !== "settled") fail("This sales out has no sales return yet");
  await work.loadProducts();
  const invs = await tx.salesInvoice.findMany({
    where: { ...work.where, issueId, fromSettlement: true },
    include: { details: { orderBy: { line: "asc" } }, payments: true },
  });
  const orderCache = new Map();
  const getOrder = async (id) => {
    if (!orderCache.has(id)) {
      orderCache.set(id, await tx.salesOrder.findFirst({ where: { ...work.where, id }, include: { details: { orderBy: { line: "asc" } } } }));
    }
    return orderCache.get(id);
  };

  // checks first, so nothing changes when the undo is not possible
  for (const inv of invs) {
    if (inv.returnedAmount > 0) fail(`${inv.invoiceNo} already has a customer return, so this sales return can't change`);
    if (inv.payments.some((p) => p.issueId !== issueId)) fail(`${inv.invoiceNo} has a payment received later, so this sales return can't change`);
    const o = inv.salesOrderId ? await getOrder(inv.salesOrderId) : null;
    if (o && (o.issueHistory || []).at(-1) !== issueId) {
      const other = await tx.productIssue.findFirst({ where: { id: o.issueHistory.at(-1) }, select: { issueNo: true } });
      fail(`Order ${o.orderNo} is now on sales out ${other?.issueNo || ""}, so this sales return can't change`);
    }
  }
  await work.loadLots(invs.flatMap((i) => i.details.map((d) => d.stockDetailsId)));
  const back = {};
  issue.details.forEach((d) => {
    back[d.stockDetailsId] = r3((back[d.stockDetailsId] || 0) + d.returnedQuantity);
  });
  if (checkStock) {
    Object.entries(back).forEach(([lotId, q]) => {
      const lot = work.lot(lotId);
      if (q > lotAvailable(lot) + 0.0005) {
        fail(`${work.pName(lot.productId)}: ${q} were returned but only ${lotAvailable(lot)} of that lot is still in stock, so the sales return can't be undone. Edit it instead.`);
      }
    });
  }

  // 1) remove the invoices; their stock is back with the employee
  for (const inv of invs) {
    const o = inv.salesOrderId ? await getOrder(inv.salesOrderId) : null;
    for (const d of inv.details) {
      const lot = work.lot(d.stockDetailsId);
      lot.soldQuantity = r3(lot.soldQuantity - d.salesQuantity);
      lot.issuedQuantity = r3(lot.issuedQuantity + d.salesQuantity);
      let left = d.salesQuantity;
      issue.details
        .filter((x) => x.stockDetailsId === d.stockDetailsId)
        .forEach((x) => {
          const t = Math.min(left, x.soldQuantity);
          x.soldQuantity = r3(x.soldQuantity - t);
          left = r3(left - t);
        });
      if (o) {
        let undo = d.salesQuantity;
        for (const x of o.details.filter((y) => y.stockSummaryId === d.stockSummaryId)) {
          const t = Math.min(undo, x.deliveredQuantity);
          if (t <= 0) continue;
          x.deliveredQuantity = r3(x.deliveredQuantity - t);
          undo = r3(undo - t);
          await tx.salesOrderDetails.update({ where: { id: x.id }, data: { deliveredQuantity: x.deliveredQuantity } });
        }
      }
      work.recalc(d.stockSummaryId);
    }
  }
  if (invs.length) await tx.salesInvoice.deleteMany({ where: { ...work.where, id: { in: invs.map((i) => i.id) } } });

  // 2) returned stock goes back out of the lots
  issue.details.forEach((d) => {
    if (!(d.returnedQuantity > 0)) return;
    const lot = work.lot(d.stockDetailsId);
    lot.issuedQuantity = r3(lot.issuedQuantity + d.returnedQuantity);
    d.returnedQuantity = 0;
    work.recalc(d.stockSummaryId);
  });

  // 3) shortages are removed
  const shortages = await tx.stockAdjustment.findMany({ where: { ...work.where, issueId, adjustmentType: "shortage" } });
  await work.loadLots(shortages.map((a) => a.stockDetailsId));
  shortages.forEach((a) => {
    const lot = work.lot(a.stockDetailsId);
    lot.adjustQuantity = r3(lot.adjustQuantity - a.quantity);
    lot.issuedQuantity = r3(lot.issuedQuantity + a.quantity);
    work.recalc(a.stockSummaryId);
  });
  if (shortages.length) await tx.stockAdjustment.deleteMany({ where: { ...work.where, id: { in: shortages.map((a) => a.id) } } });
  issue.details.forEach((d) => {
    d.shortQuantity = 0;
  });

  // 4) orders whose last trip was this one go back on it
  const appDelivered = new Set(
    (
      await tx.salesInvoice.findMany({
        where: { ...work.where, issueId, salesOrderId: { not: null } },
        select: { salesOrderId: true },
      })
    ).map((i) => i.salesOrderId),
  );
  const tripOrders = await tx.salesOrder.findMany({
    where: { ...work.where, issueHistory: { has: issueId }, status: { not: "cancelled" } },
    include: { details: true },
  });
  for (const o of tripOrders.filter((x) => x.issueHistory.at(-1) === issueId && (!x.issueId || x.issueId === issueId))) {
    const details = orderCache.get(o.id)?.details || o.details;
    const allDone = details.every((d) => d.deliveredQuantity >= d.quantity - 0.0005);
    await tx.salesOrder.update({
      where: { id: o.id },
      data: {
        issueId,
        deliveryManId: issue.employeeId,
        status: appDelivered.has(o.id) ? (allDone ? "delivered" : "partial") : "issued",
        closedIssueId: null,
        closedAt: null,
      },
    });
  }

  // 5) cash
  await tx.issueExpense.deleteMany({ where: { ...work.where, issueId } });
  issue.expenses = [];
  await work.updateIssue(issue, {
    status: "open",
    totalSales: 0,
    cashCollected: 0,
    totalExpense: 0,
    cashDeposited: 0,
    cashShortExcess: 0,
    settledById: null,
    settledAt: null,
  });
  return issue;
};

/** Edit a sales return: undo it and save it again with the new figures, on its original date. */
const updateSettlement = async (work, issueId, payload) => {
  const issue = await work.loadIssue(issueId);
  if (!issue) fail("Sales out not found");
  const { settledAt, settledById } = issue;
  await unsettleIssue(work, issueId, { checkStock: false });
  await settleIssue(work, issueId, { ...payload, date: settledAt });
  // returned stock that was sold since can't be taken back
  issue.details.forEach((d) => {
    const lot = work.lot(d.stockDetailsId);
    if (lotAvailable(lot) < -0.0005) {
      fail(`${work.pName(lot.productId)}: ${r3(-lotAvailable(lot))} more must stay returned – that returned stock has been sold since`);
    }
  });
  await work.updateIssue(issue, { settledById, editedById: work.ctx.userId, editedAt: new Date().toISOString() });
  return issue;
};

/** Delete a sales return: the sales out goes back to waiting for its sales return. */
const deleteSettlement = (work, issueId) => unsettleIssue(work, issueId);

const cancelIssue = async (work, issueId) => {
  const { tx } = work;
  const issue = await work.loadIssue(issueId);
  if (!issue) fail("Issue not found");
  if (issue.status !== "open") fail("Only open issues can be cancelled");
  if (issue.details.some((d) => d.soldQuantity > 0)) fail("Issue already has sales, settle it instead");
  issue.details.forEach((d) => {
    const lot = work.lot(d.stockDetailsId);
    lot.issuedQuantity = r3(lot.issuedQuantity - d.issuedQuantity);
    d.returnedQuantity = d.issuedQuantity;
    work.recalc(d.stockSummaryId);
  });
  const orders = await tx.salesOrder.findMany({ where: { ...work.where, issueId }, include: { details: true } });
  for (const o of orders) {
    await tx.salesOrder.update({
      where: { id: o.id },
      data: { status: o.details.some((d) => d.deliveredQuantity > 0) ? "partial" : "pending", issueId: null, deliveryManId: null },
    });
  }
  await work.updateIssue(issue, { status: "cancelled" });
  return issue;
};

/**
 * Delete a sales out for good. Its stock goes back to available and its orders back to the queue.
 * A sales out with a sales return, or with deliveries already made, can't be deleted.
 */
const deleteIssue = async (work, issueId) => {
  const { tx } = work;
  const issue = await work.loadIssue(issueId);
  if (!issue) fail("Sales out not found");
  if (issue.status === "settled") fail(`${issue.issueNo} has a sales return. Undo it on All Sales Return first.`);
  const hasSales =
    (await tx.salesInvoice.count({ where: { ...work.where, issueId } })) > 0 ||
    (await tx.customerPayment.count({ where: { ...work.where, issueId } })) > 0;
  if (hasSales || issue.details.some((d) => d.soldQuantity > 0)) fail(`${issue.issueNo} already has deliveries. Do its sales return instead.`);
  if (issue.status === "open") await cancelIssue(work, issueId);
  const orders = await tx.salesOrder.findMany({ where: { ...work.where, issueHistory: { has: issueId } } });
  for (const o of orders) {
    await tx.salesOrder.update({ where: { id: o.id }, data: { issueHistory: o.issueHistory.filter((x) => x !== issueId) } });
  }
  await tx.notification.deleteMany({ where: { ...work.where, refType: "ProductIssue", refId: issueId } });
  await work.flush();
  work.forgetIssue(issueId);
  await tx.productIssue.delete({ where: { id: issueId } });
  return { id: issue.id, issueNo: issue.issueNo };
};

/* ------------------------------------------------------------------ */
/* Sales order                                                         */
/* ------------------------------------------------------------------ */

const orderLineFromSku = (sku, l, tenant) => ({
  ...tenant,
  productId: sku.productId,
  stockSummaryId: sku.id,
  skuPrice: sku.sellingPrice,
  unitPrice: r2(l.unitPrice ?? sku.sellingPrice),
  quantity: r3(l.quantity),
  deliveredQuantity: 0,
});

/** Save an order. Stock does not change. Sync is idempotent with clientRefId. */
const createOrder = async (tx, ctx, { customerId, srId, orderDate, lines = [], remark, clientRefId }) => {
  const where = { storeId: ctx.storeId };
  const tenant = { storeId: ctx.storeId, companyId: ctx.companyId };
  if (clientRefId) {
    const dup = await tx.salesOrder.findFirst({ where: { ...where, clientRefId }, include: { details: true } });
    if (dup) return dup; // idempotent sync
  }
  if (!customerId || !(await tx.customer.findFirst({ where: { ...where, id: customerId }, select: { id: true } }))) fail("Select a retailer");
  if (!srId || !(await tx.employee.findFirst({ where: { ...where, id: srId, type: "sr" }, select: { id: true } }))) fail("Select an SR");
  const valid = lines.filter((l) => Number(l.quantity) > 0);
  if (!valid.length) fail("Add at least one product");
  const skus = await tx.stockSummary.findMany({ where: { ...where, id: { in: valid.map((l) => l.skuId) } } });
  await blockSerialSkus(tx, where, skus.map((s) => s.id));
  const details = valid.map((l) => {
    const sku = skus.find((s) => s.id === l.skuId);
    if (!sku) fail("SKU not found");
    return orderLineFromSku(sku, l, tenant);
  });
  return tx.salesOrder.create({
    data: {
      ...tenant,
      orderNo: await nextNo(tx, ctx, "SO"),
      clientRefId: clientRefId || null,
      customerId,
      srId,
      orderDate: dayjs(orderDate || undefined).toISOString(),
      status: "pending",
      remark: remark || "",
      totalAmount: r2(details.reduce((a, d) => a + d.quantity * d.unitPrice, 0)),
      details: { create: details },
    },
    include: { details: { orderBy: { line: "asc" } } },
  });
};

const cancelOrder = async (tx, ctx, orderId) => {
  const o = await tx.salesOrder.findFirst({ where: { storeId: ctx.storeId, id: orderId } });
  if (!o) fail("Order not found");
  if (o.status === "closed") fail("This order was closed by its sales return and cannot change");
  if (!["pending", "partial"].includes(o.status)) fail("Only pending or partial orders can be cancelled");
  if (o.issueId) fail("Order is on an open issue");
  return tx.salesOrder.update({ where: { id: orderId }, data: { status: "cancelled", updatedById: ctx.userId } });
};

/**
 * Admin edit of an order in any status. A line that has deliveries keeps its price, can't go
 * below the delivered qty and can't be removed; retailer and SR are locked once anything is delivered.
 */
const updateOrder = async (tx, ctx, orderId, { customerId, srId, orderDate, lines = [], remark }) => {
  const where = { storeId: ctx.storeId };
  const tenant = { storeId: ctx.storeId, companyId: ctx.companyId };
  const o = await tx.salesOrder.findFirst({ where: { ...where, id: orderId }, include: { details: true } });
  if (!o) fail("Order not found");
  if (!customerId) fail("Select a retailer");
  const valid = lines.filter((l) => Number(l.quantity) > 0);
  if (!valid.length) fail("Add at least one product");
  const anyDelivered = o.details.some((d) => d.deliveredQuantity > 0);
  if (anyDelivered && (customerId !== o.customerId || srId !== o.srId)) fail("Retailer and SR cannot change after a delivery");
  if (customerId !== o.customerId && !(await tx.customer.findFirst({ where: { ...where, id: customerId }, select: { id: true } }))) fail("Select a retailer");

  const products = await tx.product.findMany({ where, select: { id: true, name: true } });
  const pName = (id) => products.find((p) => p.id === id)?.name || "Product";
  o.details
    .filter((d) => d.deliveredQuantity > 0)
    .forEach((d) => {
      const ln = valid.find((l) => l.detailId === d.id);
      if (!ln) fail(`${pName(d.productId)} is already delivered and cannot be removed`);
      if (r3(ln.quantity) < d.deliveredQuantity - 0.0005) fail(`${pName(d.productId)}: qty cannot be less than the ${d.deliveredQuantity} delivered`);
      if (ln.unitPrice != null && r2(ln.unitPrice) !== d.unitPrice) fail(`${pName(d.productId)}: price cannot change after delivery`);
    });
  const skus = await tx.stockSummary.findMany({ where: { ...where, id: { in: valid.filter((l) => !l.detailId).map((l) => l.skuId) } } });
  await blockSerialSkus(tx, where, skus.map((x) => x.id));
  valid.forEach((l) => {
    if (!l.detailId && !skus.some((s) => s.id === l.skuId)) fail("SKU not found");
    if (l.detailId && !o.details.some((d) => d.id === l.detailId)) fail("Order line not found");
  });

  const keep = new Set(valid.map((l) => l.detailId).filter(Boolean));
  const removed = o.details.filter((d) => !keep.has(d.id)).map((d) => d.id);
  if (removed.length) await tx.salesOrderDetails.deleteMany({ where: { id: { in: removed } } });
  const details = [];
  for (const l of valid) {
    const old = l.detailId && o.details.find((d) => d.id === l.detailId);
    if (old) {
      const upd = { unitPrice: old.deliveredQuantity > 0 ? old.unitPrice : r2(l.unitPrice ?? old.unitPrice), quantity: r3(l.quantity) };
      await tx.salesOrderDetails.update({ where: { id: old.id }, data: upd });
      details.push({ ...old, ...upd });
    } else {
      const row = await tx.salesOrderDetails.create({
        data: { ...orderLineFromSku(skus.find((s) => s.id === l.skuId), l, tenant), salesOrderId: orderId },
      });
      details.push(row);
    }
  }

  const data = {
    customerId,
    srId,
    remark: remark || "",
    totalAmount: r2(details.reduce((a, d) => a + d.quantity * d.unitPrice, 0)),
    updatedById: ctx.userId,
  };
  if (orderDate) data.orderDate = dayjs(orderDate).toISOString();

  const allDone = details.every((d) => d.deliveredQuantity >= d.quantity - 0.0005);
  if (o.status === "closed") {
    // a closed order's cycle is over: it only becomes "delivered" if the edit leaves nothing undelivered
    if (allDone) data.status = "delivered";
  } else if (o.status !== "cancelled") {
    const any = details.some((d) => d.deliveredQuantity > 0);
    const issue = o.issueId ? await tx.productIssue.findFirst({ where: { id: o.issueId }, select: { status: true } }) : null;
    const issueOpen = issue?.status === "open";
    if (allDone) data.status = "delivered";
    else {
      data.status = any ? "partial" : issueOpen ? "issued" : "pending";
      if (!issueOpen) Object.assign(data, { issueId: null, deliveryManId: null });
    }
  }
  return tx.salesOrder.update({ where: { id: orderId }, data, include: { details: { orderBy: { line: "asc" } } } });
};

/**
 * Admin delete of an order in any status. Stock is untouched: goods already sent out come back
 * through the sales return, and invoices already made stay in sales history.
 */
const deleteOrder = async (tx, ctx, orderId) => {
  const o = await tx.salesOrder.findFirst({ where: { storeId: ctx.storeId, id: orderId } });
  if (!o) fail("Order not found");
  await tx.salesOrder.delete({ where: { id: orderId } });
  return { id: o.id, orderNo: o.orderNo };
};

module.exports = {
  issueSkuSummary,
  createIssue,
  deliverOrder,
  settleIssue,
  unsettleIssue,
  updateSettlement,
  deleteSettlement,
  cancelIssue,
  deleteIssue,
  createOrder,
  cancelOrder,
  updateOrder,
  deleteOrder,
};
