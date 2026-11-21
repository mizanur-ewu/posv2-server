const dayjs = require("dayjs");
const { r2, r3, toDate, today } = require("../helperFunction");
const { ADJUSTMENT_TYPES } = require("./constants");
const { fail, lotAvailable, allocate, nextNo, sweepDiscounts } = require("./stockWork");
const { addSerials, takeSerials, markGone, backInStock } = require("./serials");

/* ------------------------------------------------------------------ */
/* Stock return & adjustment                                           */
/* ------------------------------------------------------------------ */

/** Supplier of the stock entry a lot came from (following splits back). */
const supplierOfLot = async (work, lot) => {
  if (!lot?.rootStockId) return null;
  const stock = await work.tx.stock.findFirst({ where: { id: lot.rootStockId }, select: { supplierId: true } });
  return stock?.supplierId || null;
};

const postAdjustment = async (work, { lot, type, quantity, reason, supplierId, date, refNo }) => {
  const meta = ADJUSTMENT_TYPES[type];
  lot.adjustQuantity = r3(lot.adjustQuantity + (meta.direction === "out" ? quantity : -quantity));
  return work.tx.stockAdjustment.create({
    data: {
      ...work.tenant,
      refNo,
      stockDetailsId: lot.id,
      stockSummaryId: lot.stockSummaryId,
      adjustmentType: type,
      direction: meta.direction,
      quantity: r3(quantity),
      reason: reason || "",
      supplierId: type === "supplier_return" ? supplierId || (await supplierOfLot(work, lot)) : null,
      amount: r2(quantity * lot.purchasePrice),
      date: toDate(date),
      createdById: work.ctx.userId,
    },
  });
};

const checkType = (type) => {
  const meta = ADJUSTMENT_TYPES[type];
  if (!meta || type === "shortage") fail("Select an adjustment type");
  return meta;
};

/**
 * Manual stock adjustment.
 * "out" types take stock out of one lot (lotId) or across the SKU's lots FEFO → FIFO.
 * "in" (count gain) adds back to the chosen lot, or the SKU's latest lot.
 */
const createAdjustment = async (work, { type, skuId, lotId, quantity, reason, supplierId, date, serials }) => {
  const meta = checkType(type);
  const q = r3(quantity);
  if (!(q > 0)) fail("Quantity must be greater than 0");
  await work.loadSkus([skuId]);
  const sku = work.sku(skuId);
  if (!sku) fail("Select a SKU");
  await work.loadProducts();
  const product = work.product(sku.productId);
  const named = product?.trackSerial ? { ...product, name: work.pName(product.id) } : null;
  // IMEI / serial products: the units going out (or found) are named
  const outRows = named && meta.direction === "out" ? await takeSerials(work.tx, work.ctx, { product: named, serials, quantity: q }) : null;
  const lots = work.skuLots(skuId).filter((l) => !lotId || l.id === lotId);
  if (!lots.length) fail("Lot not found");

  let picks;
  if (meta.direction === "out") {
    picks = allocate(lots, q, lotAvailable);
    if (!picks) fail(`Only ${r3(lots.reduce((a, l) => a + Math.max(0, lotAvailable(l)), 0))} available${lotId ? " in this lot" : ""}`);
  } else {
    const lot = lotId ? lots[0] : [...lots].sort((a, b) => dayjs(b.date).valueOf() - dayjs(a.date).valueOf() || b.seq - a.seq)[0];
    picks = [{ lot, q }];
  }

  const refNo = await nextNo(work.tx, work.ctx, "AD");
  const when = date ? dayjs(date).format("YYYY-MM-DD") : today();
  const records = [];
  for (const { lot, q: lq } of picks) {
    records.push(await postAdjustment(work, { lot: work.lot(lot.id), type, quantity: lq, reason, supplierId, date: when, refNo }));
  }
  work.recalc(skuId);
  if (outRows) await markGone(work.tx, outRows, type, refNo);
  if (named && meta.direction === "in") await addSerials(work.tx, work.ctx, { product: named, serials, quantity: q, adjustmentRef: refNo, purchasePrice: picks[0].lot.purchasePrice });
  return { refNo, records };
};

/**
 * Return / adjust stock of one stock entry, lot by lot.
 * items: [{ lotId, quantity }] — lots of the entry, including its repriced / discount split lots.
 */
const adjustStockEntry = async (work, { stockId, type, items = [], reason, date }) => {
  const meta = checkType(type);
  const stock = await work.tx.stock.findFirst({ where: { ...work.where, id: stockId } });
  if (!stock) fail("Stock entry not found");
  const valid = items.filter((i) => Number(i.quantity) > 0);
  if (!valid.length) fail("Enter a quantity for at least one item");
  await work.loadProducts();
  const lots = await work.loadEntry(stockId);
  valid.forEach((i) => {
    const lot = lots.find((l) => l.id === i.lotId);
    if (!lot) fail("Lot not found on this entry");
    if (meta.direction === "out" && r3(i.quantity) > lotAvailable(lot) + 0.0005) {
      fail(`${work.pName(lot.productId)}: only ${lotAvailable(lot)} available in lot #${lot.seq}`);
    }
  });
  const refNo = await nextNo(work.tx, work.ctx, "AD");
  const when = date ? dayjs(date).format("YYYY-MM-DD") : today();
  const records = [];
  for (const i of valid) {
    const lot = lots.find((l) => l.id === i.lotId);
    const product = work.product(lot.productId);
    const named = product?.trackSerial ? { ...product, name: work.pName(product.id) } : null;
    const outRows = named && meta.direction === "out" ? await takeSerials(work.tx, work.ctx, { product: named, serials: i.serials, quantity: r3(i.quantity) }) : null;
    records.push(await postAdjustment(work, { lot, type, quantity: r3(i.quantity), reason, supplierId: stock.supplierId, date: when, refNo }));
    work.recalc(lot.stockSummaryId);
    if (outRows) await markGone(work.tx, outRows, type, refNo);
    if (named && meta.direction === "in") await addSerials(work.tx, work.ctx, { product: named, serials: i.serials, quantity: r3(i.quantity), adjustmentRef: refNo, purchasePrice: lot.purchasePrice });
  }
  return { refNo, records };
};

/** Edit a manual adjustment: type (same direction), quantity, reason, date. */
const updateAdjustment = async (work, id, { type, quantity, reason, date }) => {
  const a = await work.tx.stockAdjustment.findFirst({ where: { ...work.where, id } });
  if (!a) fail("Adjustment not found");
  if (a.adjustmentType === "shortage") fail("Shortages come from Sales Return and can only change there");
  const newType = type || a.adjustmentType;
  const meta = checkType(newType);
  if (meta.direction !== (a.direction || "out")) fail("A stock-out adjustment cannot become a stock-in one. Delete it and add a new one.");
  const [lot] = await work.loadLots([a.stockDetailsId]);
  if (!lot) fail("Lot not found");
  await work.loadProducts();
  if (work.product(lot.productId)?.trackSerial) fail(`${work.pName(lot.productId)} has IMEI / serial numbers: delete this adjustment and add it again`);
  const q = r3(quantity);
  if (!(q > 0)) fail("Quantity must be greater than 0");
  const delta = r3(q - a.quantity);
  const out = meta.direction === "out";
  // out: more qty needs stock; in: less qty takes stock back out
  const need = out ? delta : -delta;
  if (need > 0 && need > lotAvailable(lot) + 0.0005) fail(`Only ${lotAvailable(lot)} more available in this lot`);
  lot.adjustQuantity = r3(lot.adjustQuantity + (out ? delta : -delta));
  work.recalc(lot.stockSummaryId);
  return work.tx.stockAdjustment.update({
    where: { id },
    data: {
      adjustmentType: newType,
      quantity: q,
      reason: reason ?? a.reason,
      date: toDate(date || a.date),
      amount: r2(q * lot.purchasePrice),
      supplierId: newType === "supplier_return" ? a.supplierId || (await supplierOfLot(work, lot)) : null,
      updatedById: work.ctx.userId,
    },
  });
};

/** Delete a manual adjustment; the stock goes back into (or, for a count gain, out of) its lot. */
const deleteAdjustment = async (work, id) => {
  const a = await work.tx.stockAdjustment.findFirst({ where: { ...work.where, id } });
  if (!a) fail("Adjustment not found");
  if (a.adjustmentType === "shortage") fail("Shortages come from Sales Return and can’t be deleted here");
  const [first] = await work.loadLots([a.stockDetailsId]);
  await work.loadProducts();
  const serialProduct = first && work.product(first.productId)?.trackSerial ? first.productId : null;
  if (serialProduct && a.refNo) {
    const siblings = await work.tx.stockAdjustment.findMany({ where: { ...work.where, refNo: a.refNo, stockSummaryId: a.stockSummaryId } });
    const out = (a.direction || "out") === "out";
    if (!out) {
      const gone = await work.tx.serialNumber.count({ where: { ...work.where, adjustmentRef: a.refNo, productId: serialProduct, status: { not: "in_stock" } } });
      if (gone) fail("Some of the units found in this count were sold since; the count gain can't be removed");
    }
    for (const s of siblings) {
      const [lot] = await work.loadLots([s.stockDetailsId]);
      if (lot) {
        if (!out && s.quantity > lotAvailable(lot) + 0.0005) fail(`Only ${lotAvailable(lot)} left in the lot, the count gain can't be removed`);
        lot.adjustQuantity = r3(lot.adjustQuantity - (out ? s.quantity : -s.quantity));
        work.recalc(lot.stockSummaryId);
      }
      await work.tx.stockAdjustment.delete({ where: { id: s.id } });
    }
    if (out) await backInStock(work.tx, { ...work.where, adjustmentRef: a.refNo, productId: serialProduct });
    else await work.tx.serialNumber.deleteMany({ where: { ...work.where, adjustmentRef: a.refNo, productId: serialProduct, status: "in_stock" } });
    return a;
  }
  const [lot] = await work.loadLots([a.stockDetailsId]);
  const out = (a.direction || "out") === "out";
  if (lot) {
    if (!out && a.quantity > lotAvailable(lot) + 0.0005) fail(`Only ${lotAvailable(lot)} left in the lot, the count gain can't be removed`);
    lot.adjustQuantity = r3(lot.adjustQuantity - (out ? a.quantity : -a.quantity));
    work.recalc(lot.stockSummaryId);
  }
  await work.tx.stockAdjustment.delete({ where: { id } });
  return a;
};

/* ------------------------------------------------------------------ */
/* Discount                                                            */
/* ------------------------------------------------------------------ */

/** Amount off one unit. Percent can be capped (0 / empty = no cap). */
const discountPerUnit = (price, mode, value, cappedAt) => {
  const v = Number(value) || 0;
  if (mode === "percentage") {
    const off = (price * v) / 100;
    const cap = Number(cappedAt) || 0;
    return r2(cap > 0 ? Math.min(off, cap) : off);
  }
  return r2(v);
};

/**
 * Put part of a SKU's stock on discount. That quantity moves (FEFO → FIFO, same lot cost and
 * expiry) into a SKU of its own at the discount price. When the discount ends, whatever is left
 * goes back to the regular SKU.
 */
const createDiscount = async (work, { skuId, quantity, mode = "percentage", value, cappedAt, endDate }) => {
  const { tx, ctx } = work;
  if (!["percentage", "amount"].includes(mode)) fail("Select the discount type");
  await work.loadSkus([skuId]);
  const src = work.sku(skuId);
  if (!src) fail("Choose a product");
  if (src.discountId) fail("A discounted SKU can’t be discounted again");
  work.recalc(src.id);
  const q = r3(quantity);
  if (!(q > 0)) fail("Enter a quantity of more than 0");
  if (q > src.stockQuantity + 0.0005) fail(`Only ${src.stockQuantity} in stock`);
  const v = Number(value) || 0;
  if (!(v > 0)) fail("Enter a discount of more than 0");
  if (mode === "percentage" && v > 100) fail("A percent discount can be at most 100");
  const perUnit = discountPerUnit(src.sellingPrice, mode, v, cappedAt);
  const price = r2(src.sellingPrice - perUnit);
  if (!(price > 0)) fail(`The discount must be less than the price (${src.sellingPrice})`);
  if (!endDate) fail("Choose the last day");
  if (dayjs(endDate).isBefore(dayjs(), "day")) fail("Choose a day from today on");

  const picks = allocate(work.skuLots(src.id).filter((l) => l.status === "active"), q, lotAvailable);
  if (!picks) fail("Not enough stock");

  const discount = await tx.discount.create({
    data: {
      ...work.tenant,
      code: await nextNo(tx, ctx, "DS"),
      productId: src.productId,
      sourceSkuId: src.id,
      quantity: q,
      mode,
      value: v,
      cappedAt: mode === "percentage" ? Number(cappedAt) || 0 : null,
      perUnit,
      regularPrice: src.sellingPrice,
      discountPrice: price,
      startDate: toDate(today()),
      endDate: toDate(endDate),
      status: "active",
      createdById: ctx.userId,
    },
  });
  const sku = await work.createSku({ productId: src.productId, sellingPrice: price, regularPrice: src.sellingPrice, discountId: discount.id });
  for (const { lot, q: lq } of picks) {
    lot.quantity = r3(lot.quantity - lq);
    await work.createLot({
      productId: lot.productId,
      stockSummaryId: sku.id,
      purchasePrice: lot.purchasePrice,
      sellingPrice: price,
      vatPercent: lot.vatPercent,
      quantity: lq,
      expiryDate: lot.expiryDate,
      date: lot.date,
      sourceStockDetailsId: lot.id,
      discountId: discount.id,
    });
  }
  work.recalc(src.id);
  work.recalc(sku.id);
  return tx.discount.update({ where: { id: discount.id }, data: { skuId: sku.id } });
};

const updateDiscount = async (work, id, { endDate }) => {
  const d = await work.tx.discount.findFirst({ where: { ...work.where, id } });
  if (!d) fail("Discount not found");
  if (d.status === "ended") fail("This discount has already ended");
  if (!endDate) fail("Choose the last day");
  if (dayjs(endDate).isBefore(dayjs(), "day")) fail("Choose a day from today on, or end the discount now");
  return work.tx.discount.update({ where: { id }, data: { endDate: toDate(endDate) } });
};

/** End a discount now: what is left of it goes back to the regular SKU. */
const endDiscount = async (work, id) => {
  const d = await work.tx.discount.findFirst({ where: { ...work.where, id } });
  if (!d) fail("Discount not found");
  if (d.status === "ended") fail("This discount has already ended");
  await work.tx.discount.update({ where: { id }, data: { status: "ended", endedAt: new Date().toISOString() } });
  await sweepDiscounts(work);
  return work.tx.discount.findFirst({ where: { id } });
};

module.exports = {
  ADJUSTMENT_TYPES,
  createAdjustment,
  adjustStockEntry,
  updateAdjustment,
  deleteAdjustment,
  discountPerUnit,
  createDiscount,
  updateDiscount,
  endDiscount,
};
