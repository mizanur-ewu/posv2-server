const dayjs = require("dayjs");
const { r2, r3, toDate, today } = require("../helperFunction");
const { ADJUSTMENT_TYPES } = require("./constants");
const { fail, lotAvailable, nextNo } = require("./stockWork");
const { addSerials } = require("./serials");

/* ------------------------------------------------------------------ */
/* helpers on the lots of one entry                                    */
/* ------------------------------------------------------------------ */

/** Quantity moved out of a lot by repricing / discount splits (to show the original received qty). */
const splitOutQty = (lot, entryLots) =>
  r3(
    entryLots
      .filter((l) => l.sourceStockDetailsId === lot.id)
      .reduce((a, l) => a + l.quantity + splitOutQty(l, entryLots), 0),
  );

/**
 * Lowest received qty an edited lot can have: what has already gone out of it, so its available
 * stays ≥ 0. A count gain (negative adjustQuantity) is stock that came in and lowers it.
 */
const lotMinQty = (lot, entryLots) =>
  r3(Math.max(0, splitOutQty(lot, entryLots) + lot.soldQuantity + lot.issuedQuantity + lot.adjustQuantity));

/**
 * Totals of one stock entry.
 * stock, entryLots (own + split lots), payments of the entry, supplier-return adjustments on its lots.
 */
const stockTotalsFrom = ({ stock, entryLots, payments, returns }) => {
  const own = entryLots.filter((l) => l.stockId === stock.id);
  const subtotal = r2(own.reduce((a, l) => a + (l.quantity + splitOutQty(l, entryLots)) * l.purchasePrice, 0));
  const vat = r2((subtotal * (stock.vatPercent || 0)) / 100);
  const total = r2(subtotal + vat);
  const paid = r2(payments.reduce((a, p) => a + p.amount, 0));
  const returned = r2(returns.reduce((a, x) => a + x.amount, 0));
  return { subtotal, vat, total, paid, returned, due: r2(total - returned - paid), lines: own.length };
};

/**
 * Lot ids that anything (sale, issue, adjustment, split) points at – they can't be removed or re-priced.
 * lots: the lots to test, entryLots: every lot of the entry (to find splits).
 */
const usedLotIds = async (client, storeId, lots, entryLots) => {
  const ids = lots.map((l) => l.id);
  if (!ids.length) return new Set();
  const [inv, iss, adj] = await Promise.all([
    client.invoiceDetails.findMany({ where: { storeId, stockDetailsId: { in: ids } }, distinct: ["stockDetailsId"], select: { stockDetailsId: true } }),
    client.productIssueDetails.findMany({ where: { storeId, stockDetailsId: { in: ids } }, distinct: ["stockDetailsId"], select: { stockDetailsId: true } }),
    client.stockAdjustment.findMany({ where: { storeId, stockDetailsId: { in: ids } }, distinct: ["stockDetailsId"], select: { stockDetailsId: true } }),
  ]);
  const used = new Set([...inv, ...iss, ...adj].map((x) => x.stockDetailsId));
  lots.forEach((l) => {
    if (l.soldQuantity > 0 || l.issuedQuantity > 0 || l.adjustQuantity !== 0 || entryLots.some((x) => x.sourceStockDetailsId === l.id)) used.add(l.id);
  });
  return used;
};

/**
 * What stops stock entries from being deleted, and what would be removed with them.
 * blockers: sales and sales outs on any of its lots (incl. split lots) – real sales history.
 * cascade: manual adjustments, split lots and discounts, removed together with the entry.
 * lotsByStock: Map stockId → entry lots. pName: product id → name.
 */
const stockChecks = async (client, storeId, lotsByStock, pName) => {
  const allIds = [...lotsByStock.values()].flatMap((lots) => lots.map((l) => l.id));
  const discountIds = [...new Set([...lotsByStock.values()].flatMap((lots) => lots.map((l) => l.discountId).filter(Boolean)))];
  const [inv, iss, adjs, discounts] = allIds.length
    ? await Promise.all([
        client.invoiceDetails.findMany({
          where: { storeId, stockDetailsId: { in: allIds } },
          distinct: ["stockDetailsId"],
          select: { stockDetailsId: true, productId: true, invoice: { select: { invoiceNo: true } } },
        }),
        client.productIssueDetails.findMany({
          where: { storeId, stockDetailsId: { in: allIds } },
          distinct: ["stockDetailsId"],
          select: { stockDetailsId: true, productId: true, issue: { select: { issueNo: true } } },
        }),
        client.stockAdjustment.findMany({ where: { storeId, stockDetailsId: { in: allIds } } }),
        discountIds.length ? client.discount.findMany({ where: { storeId, id: { in: discountIds } } }) : [],
      ])
    : [[], [], [], []];

  const out = new Map();
  lotsByStock.forEach((lots, stockId) => {
    const ids = new Set(lots.map((l) => l.id));
    const lotById = (id) => lots.find((l) => l.id === id);
    const blockers = [];
    inv
      .filter((d) => ids.has(d.stockDetailsId))
      .forEach((d) => blockers.push({ kind: "sale", ref: d.invoice?.invoiceNo || null, product: pName(d.productId), lotSeq: lotById(d.stockDetailsId)?.seq }));
    iss
      .filter((d) => ids.has(d.stockDetailsId))
      .forEach((d) => blockers.push({ kind: "salesOut", ref: d.issue?.issueNo || null, product: pName(d.productId), lotSeq: lotById(d.stockDetailsId)?.seq }));
    if (!blockers.length) {
      const moved = lots.find((l) => l.soldQuantity > 0 || l.issuedQuantity > 0);
      if (moved) blockers.push({ kind: moved.soldQuantity > 0 ? "sale" : "salesOut", ref: null, product: pName(moved.productId), lotSeq: moved.seq });
    }

    const adjustments = adjs
      .filter((a) => ids.has(a.stockDetailsId))
      .map((a) => ({
        id: a.id,
        refNo: a.refNo,
        type: a.adjustmentType,
        label: ADJUSTMENT_TYPES[a.adjustmentType]?.label || a.adjustmentType,
        direction: a.direction || "out",
        quantity: a.quantity,
        product: pName(lotById(a.stockDetailsId)?.productId),
      }));
    // shortages only come from a sales out, which already blocks
    if (adjustments.some((a) => a.type === "shortage") && !blockers.length) {
      blockers.push({ kind: "salesOut", ref: null, product: adjustments.find((a) => a.type === "shortage").product });
    }

    const splits = lots.filter((l) => !l.stockId);
    const ownDiscounts = [...new Set(splits.map((l) => l.discountId).filter(Boolean))]
      .map((id) => discounts.find((d) => d.id === id))
      .filter(Boolean)
      .map((d) => ({
        id: d.id,
        code: d.code,
        quantity: r3(splits.filter((l) => l.discountId === d.id).reduce((a, l) => a + l.quantity, 0)),
        product: pName(d.productId),
      }));

    out.set(stockId, {
      blockers,
      cascade: { adjustments, splits: splits.map((l) => ({ id: l.id, seq: l.seq, discountId: l.discountId || null })), discounts: ownDiscounts },
    });
  });
  return out;
};

/** One sentence for the first blocker, e.g. "Mango Juice (lot #3) was sold in DHK-SI-00042". */
const stockDeleteBlockReason = (check) => {
  const b = check.blockers[0];
  if (!b) return null;
  const what = `${b.product}${b.lotSeq ? ` (lot #${b.lotSeq})` : ""}`;
  return b.kind === "sale"
    ? `${what} was sold${b.ref ? ` in ${b.ref}` : ""}`
    : `${what} was sent out${b.ref ? ` in Sales Out ${b.ref}` : ""}`;
};

/* ------------------------------------------------------------------ */
/* Selling price change popup (repricing)                              */
/* ------------------------------------------------------------------ */

/**
 * Show the popup when a line has the same purchase price as the product's latest lot but a
 * different selling price, and the old SKU still has stock. Returns conflict info or null.
 */
const priceChangeConflict = async (client, storeId, productId, purchasePrice, sellingPrice) => {
  const last = await client.stockDetails.findFirst({
    where: { storeId, productId, stockId: { not: null } },
    orderBy: [{ date: "desc" }, { seq: "desc" }],
  });
  if (!last) return null;
  if (r2(last.purchasePrice) !== r2(purchasePrice)) return null;
  if (r2(last.sellingPrice) === r2(sellingPrice)) return null;
  const oldSku = await client.stockSummary.findFirst({ where: { storeId, id: last.stockSummaryId } });
  if (!oldSku || oldSku.stockQuantity <= 0) return null;
  return {
    productId,
    oldSkuId: oldSku.id,
    oldSku: oldSku.sku,
    oldPrice: oldSku.sellingPrice,
    newPrice: r2(sellingPrice),
    availableQty: oldSku.stockQuantity,
  };
};

/** Option A: split every lot of the old SKU that has stock into the new-price SKU. */
const repriceOldSku = async (work, oldSkuId, newPrice) => {
  await work.loadSkus([oldSkuId]);
  const oldSku = work.sku(oldSkuId);
  if (!oldSku || oldSku.discountId || r2(oldSku.sellingPrice) === r2(newPrice)) return;
  const newSku = await work.findOrCreateSku(oldSku.productId, newPrice);
  for (const lot of work.skuLots(oldSkuId).filter((l) => lotAvailable(l) > 0)) {
    const av = lotAvailable(lot);
    lot.quantity = r3(lot.quantity - av);
    await work.createLot({
      productId: lot.productId,
      stockSummaryId: newSku.id,
      purchasePrice: lot.purchasePrice,
      sellingPrice: newSku.sellingPrice,
      vatPercent: lot.vatPercent,
      quantity: av,
      expiryDate: lot.expiryDate,
      date: lot.date,
      sourceStockDetailsId: lot.id,
    });
  }
  work.recalc(oldSkuId);
  work.recalc(newSku.id);
};

/* ------------------------------------------------------------------ */
/* Stock entry                                                         */
/* ------------------------------------------------------------------ */

const checkLines = async (work, lines) => {
  const products = await work.loadProducts();
  lines.forEach((ln) => {
    if (!products.has(ln.productId)) fail("Product not found");
    if (products.get(ln.productId).hasVariants) fail(`${work.pName(ln.productId)}: pick one of its variants (size, colour …)`);
    if (!(Number(ln.quantity) > 0)) fail("Quantity must be greater than 0");
    if (!(Number(ln.purchasePrice) >= 0) || !(Number(ln.sellingPrice) > 0)) fail(`${work.pName(ln.productId)}: enter the prices`);
  });
};

const checkMethod = async (tx, id) => {
  if (!id || !(await tx.paymentMethod.findUnique({ where: { id } }))) fail("Select a payment method");
};

/** Every line always becomes a new lot, under the SKU of (product, selling price). */
const createStock = async (work, payload) => {
  const { tx, ctx } = work;
  const { supplierId, supplierRefNo, date, vatPercent = 0, remark, lines = [], payment } = payload;
  if (!lines.length) fail("Add at least one product line");
  const refNo = supplierRefNo ? String(supplierRefNo).trim() : null;
  if (refNo && (await tx.stock.findFirst({ where: { ...work.where, supplierRefNo: refNo }, select: { id: true } }))) {
    fail(`Invoice no "${refNo}" already exists`);
  }
  if (supplierId && !(await tx.supplier.findFirst({ where: { ...work.where, id: supplierId }, select: { id: true } }))) {
    fail("Supplier not found");
  }
  await checkLines(work, lines);
  if (payment && payment.amount > 0) await checkMethod(tx, payment.paymentMethodId);

  const stock = await tx.stock.create({
    data: {
      ...work.tenant,
      code: await nextNo(tx, ctx, "ST"),
      supplierRefNo: refNo,
      supplierId: supplierId || null,
      vatPercent: Number(vatPercent) || 0,
      date: toDate(date || today()),
      remark: remark || "",
      createdById: ctx.userId,
    },
  });

  for (const ln of lines) {
    if (ln.repriceOption === "A" && ln.oldSkuId) await repriceOldSku(work, ln.oldSkuId, ln.sellingPrice);
    const sku = await work.findOrCreateSku(ln.productId, ln.sellingPrice);
    await work.createLot({
      stockId: stock.id,
      productId: ln.productId,
      stockSummaryId: sku.id,
      purchasePrice: ln.purchasePrice,
      sellingPrice: sku.sellingPrice,
      vatPercent: ln.vatPercent,
      quantity: ln.quantity,
      expiryDate: ln.expiryDate || null,
      date: stock.date,
    });
    work.recalc(sku.id);
    const product = work.product(ln.productId);
    if (product.trackSerial) {
      await addSerials(tx, ctx, { product: { ...product, name: work.pName(product.id) }, serials: ln.serials, quantity: ln.quantity, stockId: stock.id, purchasePrice: ln.purchasePrice });
    }
  }

  if (payment && payment.amount > 0) {
    await tx.supplierPayment.create({
      data: {
        ...work.tenant,
        supplierId: stock.supplierId,
        stockId: stock.id,
        amount: r2(payment.amount),
        paymentMethodId: payment.paymentMethodId,
        date: toDate(stock.date),
        remark: "Paid with stock entry",
        createdById: ctx.userId,
      },
    });
  }
  return stock;
};

/** Payments and supplier returns of an entry (for its totals). */
const entryMoney = async (tx, storeId, stockId, entryLots) => {
  const [payments, returns] = await Promise.all([
    tx.supplierPayment.findMany({ where: { storeId, stockId } }),
    entryLots.length
      ? tx.stockAdjustment.findMany({
          where: { storeId, adjustmentType: "supplier_return", stockDetailsId: { in: entryLots.map((l) => l.id) } },
        })
      : [],
  ]);
  return { payments, returns };
};

/**
 * Edit a stock entry. Header fields can always change. Lines:
 *  - untouched lots: everything can change, or the line can be removed
 *  - used lots: only received quantity (not below what already went out) and expiry
 *  - new lines (no lotId) become new lots
 */
const updateStock = async (work, stockId, payload) => {
  const { tx, ctx } = work;
  const stock = await tx.stock.findFirst({ where: { ...work.where, id: stockId } });
  if (!stock) fail("Stock entry not found");
  const { supplierId, supplierRefNo, date, vatPercent = 0, remark, lines = [], payment } = payload;
  if (!lines.length) fail("Add at least one product line");
  const refNo = supplierRefNo ? String(supplierRefNo).trim() : null;
  if (refNo && (await tx.stock.findFirst({ where: { ...work.where, supplierRefNo: refNo, id: { not: stockId } }, select: { id: true } }))) {
    fail(`Invoice no "${refNo}" already exists`);
  }
  if (supplierId && !(await tx.supplier.findFirst({ where: { ...work.where, id: supplierId }, select: { id: true } }))) {
    fail("Supplier not found");
  }
  await checkLines(work, lines);
  if (payment && payment.amount > 0) await checkMethod(tx, payment.paymentMethodId);

  const entry = await work.loadEntry(stockId);
  // IMEI / serial units are entered one by one: such an entry is not edited, it is deleted and entered again
  const serialProduct = [...lines.map((l) => l.productId), ...entry.filter((l) => l.stockId === stockId).map((l) => l.productId)].find((id) => work.product(id)?.trackSerial);
  if (serialProduct) {
    fail(`${work.pName(serialProduct)} has IMEI / serial numbers, so this entry can't be edited. Delete it (if nothing was sold) and enter it again, or use Stock return & adjustment.`);
  }
  const own = entry.filter((l) => l.stockId === stockId);
  const used = await usedLotIds(tx, ctx.storeId, own, entry);
  const keep = new Set(lines.map((l) => l.lotId).filter(Boolean));
  own
    .filter((l) => !keep.has(l.id))
    .forEach((l) => {
      if (used.has(l.id)) fail(`${work.pName(l.productId)}: lot #${l.seq} already has sales or adjustments and can't be removed`);
    });

  // validate before changing anything
  lines.forEach((ln) => {
    if (!ln.lotId) return;
    const lot = own.find((l) => l.id === ln.lotId);
    if (!lot) fail("Lot not found on this entry");
    if (used.has(lot.id)) {
      const name = work.pName(lot.productId);
      if (ln.productId !== lot.productId || r2(ln.purchasePrice) !== r2(lot.purchasePrice) || r2(ln.sellingPrice) !== r2(lot.sellingPrice)) {
        fail(`${name}: product and prices of a lot with sales can't change`);
      }
      if (r3(ln.quantity) < lotMinQty(lot, entry) - 0.0005) {
        fail(`${name}: quantity can't be less than ${lotMinQty(lot, entry)} (already sold, issued or adjusted)`);
      }
    }
  });

  // the new total can't drop below what is already paid / returned, and a payment can't exceed the due
  const money = await entryMoney(tx, ctx.storeId, stockId, entry);
  const before = stockTotalsFrom({ stock, entryLots: entry, ...money });
  const newSub = r2(lines.reduce((a, l) => a + r3(l.quantity) * r2(l.purchasePrice), 0));
  const newTotal = r2(newSub + (newSub * (Number(vatPercent) || 0)) / 100);
  if (before.paid + before.returned > newTotal + 0.005) {
    fail(`The new total ${newTotal} is less than what is already paid and returned (${r2(before.paid + before.returned)})`);
  }
  if (payment && payment.amount > r2(newTotal - before.paid - before.returned) + 0.005) fail("Payment is more than the due");

  own.filter((l) => !keep.has(l.id)).forEach((l) => work.deleteLot(l.id));

  const updated = await tx.stock.update({
    where: { id: stockId },
    data: {
      supplierId: supplierId || null,
      supplierRefNo: refNo,
      vatPercent: Number(vatPercent) || 0,
      date: toDate(date || stock.date),
      remark: remark || "",
      updatedById: ctx.userId,
    },
  });

  for (const ln of lines) {
    const expiryDate = ln.expiryDate ? dayjs(ln.expiryDate).format("YYYY-MM-DD") : null;
    if (ln.lotId) {
      const lot = work.lot(ln.lotId);
      if (used.has(lot.id)) {
        lot.quantity = r3(ln.quantity - splitOutQty(lot, entry));
        lot.expiryDate = expiryDate;
      } else {
        const sku = await work.findOrCreateSku(ln.productId, ln.sellingPrice);
        Object.assign(lot, {
          productId: ln.productId,
          stockSummaryId: sku.id,
          purchasePrice: r2(ln.purchasePrice),
          sellingPrice: sku.sellingPrice,
          vatPercent: Number(ln.vatPercent) || 0,
          quantity: r3(ln.quantity),
          expiryDate,
        });
      }
      lot.date = updated.date;
      continue;
    }
    if (ln.repriceOption === "A" && ln.oldSkuId) await repriceOldSku(work, ln.oldSkuId, ln.sellingPrice);
    const sku = await work.findOrCreateSku(ln.productId, ln.sellingPrice);
    await work.createLot({
      stockId,
      productId: ln.productId,
      stockSummaryId: sku.id,
      purchasePrice: ln.purchasePrice,
      sellingPrice: sku.sellingPrice,
      vatPercent: ln.vatPercent,
      quantity: ln.quantity,
      expiryDate,
      date: updated.date,
    });
  }

  // keep the entry's payments with the entry's supplier
  await tx.supplierPayment.updateMany({ where: { ...work.where, stockId }, data: { supplierId: updated.supplierId } });
  if (payment && payment.amount > 0) {
    await tx.supplierPayment.create({
      data: {
        ...work.tenant,
        supplierId: updated.supplierId,
        stockId,
        amount: r2(payment.amount),
        paymentMethodId: payment.paymentMethodId,
        date: toDate(today()),
        remark: "Paid while editing stock entry",
        createdById: ctx.userId,
      },
    });
  }
  return updated;
};

/**
 * Delete a stock entry when none of its stock was sold or sent out. Its payments, manual
 * adjustments and discount / re-price split lots go with it.
 */
const deleteStock = async (work, stockId) => {
  const { tx, ctx } = work;
  const stock = await tx.stock.findFirst({ where: { ...work.where, id: stockId } });
  if (!stock) fail("Stock entry not found");
  await work.loadProducts();
  const lots = await work.loadEntry(stockId);
  const check = (await stockChecks(tx, ctx.storeId, new Map([[stockId, lots]]), (id) => work.pName(id))).get(stockId);
  if (check.blockers.length) fail(`${stockDeleteBlockReason(check)}. Use Return to supplier or an adjustment instead.`);

  const lotIds = lots.map((l) => l.id);
  if (lotIds.length) await tx.stockAdjustment.deleteMany({ where: { ...work.where, stockDetailsId: { in: lotIds } } });
  lots.forEach((l) => work.deleteLot(l.id));

  // discounts fed by this entry: smaller, or gone when nothing else feeds them
  for (const { id, quantity } of check.cascade.discounts) {
    const d = await tx.discount.findFirst({ where: { ...work.where, id } });
    if (!d) continue;
    const stillHasLots = (await tx.stockDetails.count({ where: { ...work.where, discountId: id, id: { notIn: lotIds } } })) > 0;
    const skuReferenced =
      d.skuId &&
      ((await tx.salesOrderDetails.count({ where: { ...work.where, stockSummaryId: d.skuId } })) > 0 ||
        (await tx.invoiceDetails.count({ where: { ...work.where, stockSummaryId: d.skuId } })) > 0 ||
        (await tx.productIssueDetails.count({ where: { ...work.where, stockSummaryId: d.skuId } })) > 0);
    if (stillHasLots || skuReferenced) {
      const data = { quantity: r3(Math.max(0, d.quantity - quantity)) };
      if (!stillHasLots && d.status !== "ended") Object.assign(data, { status: "ended", endedAt: new Date().toISOString() });
      await tx.discount.update({ where: { id }, data });
    } else {
      await tx.discount.delete({ where: { id } });
      const left = d.skuId ? await tx.stockDetails.count({ where: { ...work.where, stockSummaryId: d.skuId, id: { notIn: lotIds } } }) : 1;
      if (!left) work.deleteSku(d.skuId);
    }
  }

  await tx.supplierPayment.deleteMany({ where: { ...work.where, stockId } });
  await tx.serialNumber.deleteMany({ where: { ...work.where, stockId, status: "in_stock" } });
  await work.flush();
  await tx.stock.delete({ where: { id: stockId } });
  return { id: stockId, code: stock.code, removedAdjustments: check.cascade.adjustments.length, removedDiscounts: check.cascade.discounts.length };
};

module.exports = {
  splitOutQty,
  lotMinQty,
  stockTotalsFrom,
  usedLotIds,
  stockChecks,
  stockDeleteBlockReason,
  priceChangeConflict,
  repriceOldSku,
  createStock,
  updateStock,
  deleteStock,
};
