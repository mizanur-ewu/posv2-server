const dayjs = require("dayjs");
const apiError = require("../apiError");
const { storeTransaction } = require("../storeTransaction");
const { r2, r3, toDate, today, indexBy } = require("../helperFunction");

/* ------------------------------------------------------------------ */
/* small rules shared by every stock movement                          */
/* ------------------------------------------------------------------ */

/** Every business rule failure is a 400 with a message the user can act on. */
const fail = (message) => {
  throw apiError.badRequest(message);
};

/** available = quantity − sold − adjusted − issued */
const lotAvailable = (l) => r3(l.quantity - l.soldQuantity - l.adjustQuantity - l.issuedQuantity);

const time = (d) => (d ? new Date(d).getTime() : Infinity);

/** FEFO first (earliest expiry; missing expiry last), then FIFO (oldest date, then lot #). */
const fefoFifo = (a, b) => {
  const ea = time(a.expiryDate);
  const eb = time(b.expiryDate);
  if (ea !== eb) return ea - eb;
  const da = time(a.date);
  const dbb = time(b.date);
  if (da !== dbb) return da - dbb;
  return a.seq - b.seq;
};

/** Allocate qty across lots (already filtered) using FEFO → FIFO. null = not enough. */
const allocate = (lots, quantity, availFn) => {
  let need = r3(quantity);
  const picks = [];
  for (const lot of [...lots].sort(fefoFifo)) {
    if (need <= 0) break;
    const av = availFn(lot);
    if (av <= 0) continue;
    const q = Math.min(av, need);
    picks.push({ lot, q: r3(q) });
    need = r3(need - q);
  }
  if (need > 0.0005) return null;
  return picks;
};

/** Running number per store (atomic). */
const nextCounter = async (tx, ctx, key, start = 0) => {
  const row = await tx.counter.upsert({
    where: { storeId_key: { storeId: ctx.storeId, key } },
    create: { storeId: ctx.storeId, companyId: ctx.companyId, key, value: start + 1 },
    update: { value: { increment: 1 } },
  });
  return row.value;
};

/** Document number, e.g. DHK-SI-00042 */
const nextNo = async (tx, ctx, kind) =>
  `${ctx.storeCode}-${kind}-${String(await nextCounter(tx, ctx, kind)).padStart(5, "0")}`;

/* ------------------------------------------------------------------ */
/* Unit of work                                                        */
/* ------------------------------------------------------------------ */

const LOT_FIELDS = [
  "productId",
  "stockSummaryId",
  "purchasePrice",
  "sellingPrice",
  "vatPercent",
  "quantity",
  "soldQuantity",
  "adjustQuantity",
  "issuedQuantity",
  "expiryDate",
  "date",
  "status",
  "discountId",
];
const ISSUE_DETAIL_FIELDS = ["issuedQuantity", "soldQuantity", "returnedQuantity", "shortQuantity"];
const DATE_FIELDS = new Set(["expiryDate", "date"]);

const pick = (obj, fields) => Object.fromEntries(fields.map((f) => [f, obj[f] ?? null]));
const same = (a, b) => {
  if (typeof a === "number" || typeof b === "number") return Math.abs((Number(a) || 0) - (Number(b) || 0)) < 0.0005;
  return (a ?? null) === (b ?? null);
};

/**
 * Lots, SKUs and issue lines of one store transaction.
 * A SKU is always loaded together with ALL its lots, so the SKU cache (stockQuantity,
 * soldQuantity, issuedQuantity) is recalculated from the real lots. Changes are written by
 * flush(): only the rows that changed are updated.
 */
class StockWork {
  constructor(tx, ctx) {
    this.tx = tx;
    this.ctx = ctx;
    this.lots = new Map();
    this.lotOrig = new Map();
    this.skus = new Map();
    this.loadedSkus = new Set();
    this.dirtySkus = new Set();
    this.deletedLots = new Set();
    this.deletedSkus = new Set();
    this.issues = new Map();
    this.detOrig = new Map();
    this._products = null;
  }

  get tenant() {
    return { storeId: this.ctx.storeId, companyId: this.ctx.companyId };
  }

  get where() {
    return { storeId: this.ctx.storeId };
  }

  /* ---------------- products (names for messages) ---------------- */
  async loadProducts() {
    if (!this._products) {
      const list = await this.tx.product.findMany({
        where: this.where,
        select: { id: true, name: true, code: true, unitId: true, purchasePrice: true, sellingPrice: true, vatPercent: true, parentId: true, variantName: true, hasVariants: true, trackSerial: true, warrantyMonths: true },
      });
      this._products = indexBy(list);
    }
    return this._products;
  }

  pName(productId) {
    const p = this._products?.get(productId);
    if (!p) return "Product";
    return p.variantName ? `${p.name} (${p.variantName})` : p.name;
  }

  product(productId) {
    return this._products?.get(productId) || null;
  }

  /* ---------------- lots & SKUs ---------------- */
  _trackLot(l) {
    if (this.lots.has(l.id)) return this.lots.get(l.id);
    this.lots.set(l.id, l);
    this.lotOrig.set(l.id, pick(l, LOT_FIELDS));
    return l;
  }

  /** Load SKUs with all of their lots. */
  async loadSkus(ids) {
    const need = [...new Set(ids)].filter((id) => id && !this.loadedSkus.has(id));
    if (!need.length) return;
    const skus = await this.tx.stockSummary.findMany({ where: { ...this.where, id: { in: need } } });
    const lots = await this.tx.stockDetails.findMany({ where: { ...this.where, stockSummaryId: { in: need } } });
    skus.forEach((s) => this.skus.set(s.id, s));
    need.forEach((id) => this.loadedSkus.add(id));
    lots.forEach((l) => this._trackLot(l));
  }

  /** Load lots by id (their SKUs come with them). */
  async loadLots(ids) {
    const need = [...new Set(ids)].filter((id) => id && !this.lots.has(id));
    if (need.length) {
      const rows = await this.tx.stockDetails.findMany({
        where: { ...this.where, id: { in: need } },
        select: { id: true, stockSummaryId: true },
      });
      await this.loadSkus(rows.map((r) => r.stockSummaryId));
    }
    return ids.map((id) => this.lots.get(id));
  }

  /** Every lot that holds stock of a stock entry: its own lots plus the split lots made from them. */
  async loadEntry(stockId) {
    const rows = await this.tx.stockDetails.findMany({
      where: { ...this.where, rootStockId: stockId },
      select: { id: true, stockSummaryId: true },
    });
    await this.loadSkus(rows.map((r) => r.stockSummaryId));
    return rows.map((r) => this.lots.get(r.id)).filter((l) => l && !this.deletedLots.has(l.id));
  }

  lot(id) {
    return this.lots.get(id);
  }

  sku(id) {
    return this.skus.get(id);
  }

  skuLots(skuId) {
    return [...this.lots.values()].filter((l) => l.stockSummaryId === skuId && !this.deletedLots.has(l.id));
  }

  async createSku({ productId, sellingPrice, regularPrice = null, discountId = null }) {
    const n = await nextCounter(this.tx, this.ctx, "SKU", 100100);
    const sku = await this.tx.stockSummary.create({
      data: { ...this.tenant, sku: `SK${n}`, productId, sellingPrice: r2(sellingPrice), regularPrice, discountId },
    });
    this.skus.set(sku.id, sku);
    this.loadedSkus.add(sku.id);
    return sku;
  }

  /** SKU of (product, selling price). Discount SKUs are never reused by stock entries or repricing. */
  async findOrCreateSku(productId, sellingPrice) {
    const price = r2(sellingPrice);
    const known = (s) => !this.deletedSkus.has(s.id) && s.productId === productId && !s.discountId && r2(s.sellingPrice) === price;
    let sku = [...this.skus.values()].find(known);
    if (!sku) {
      const found = await this.tx.stockSummary.findFirst({
        where: { ...this.where, productId, discountId: null, sellingPrice: price },
        select: { id: true },
      });
      if (found) {
        await this.loadSkus([found.id]);
        sku = this.skus.get(found.id);
      }
    }
    return sku || this.createSku({ productId, sellingPrice: price });
  }

  async createLot(data) {
    const seq = await nextCounter(this.tx, this.ctx, "LOT");
    let rootStockId = data.stockId || null;
    if (!rootStockId && data.sourceStockDetailsId) rootStockId = this.lot(data.sourceStockDetailsId)?.rootStockId || null;
    const lot = await this.tx.stockDetails.create({
      data: {
        ...this.tenant,
        seq,
        stockId: data.stockId || null,
        rootStockId,
        productId: data.productId,
        stockSummaryId: data.stockSummaryId,
        purchasePrice: r2(data.purchasePrice),
        sellingPrice: r2(data.sellingPrice),
        vatPercent: Number(data.vatPercent) || 0,
        quantity: r3(data.quantity),
        expiryDate: toDate(data.expiryDate),
        date: toDate(data.date || today()),
        sourceStockDetailsId: data.sourceStockDetailsId || null,
        discountId: data.discountId || null,
        createdById: this.ctx.userId,
      },
    });
    this._trackLot(lot);
    this.dirtySkus.add(lot.stockSummaryId);
    return lot;
  }

  deleteLot(id) {
    this.deletedLots.add(id);
    const lot = this.lots.get(id);
    if (lot) this.dirtySkus.add(lot.stockSummaryId);
  }

  deleteSku(id) {
    this.deletedSkus.add(id);
  }

  /** SKU cache from its lots (in memory; written by flush). */
  recalc(skuId) {
    const sku = this.skus.get(skuId);
    if (!sku) return;
    const lots = this.skuLots(skuId);
    sku.stockQuantity = r3(lots.reduce((a, l) => a + lotAvailable(l), 0));
    sku.soldQuantity = r3(lots.reduce((a, l) => a + l.soldQuantity, 0));
    sku.issuedQuantity = r3(lots.reduce((a, l) => a + l.issuedQuantity, 0));
    this.dirtySkus.add(skuId);
  }

  /* ---------------- issues (sales out) ---------------- */
  async loadIssue(issueId) {
    if (this.issues.has(issueId)) return this.issues.get(issueId);
    const issue = await this.tx.productIssue.findFirst({
      where: { ...this.where, id: issueId },
      include: { details: { orderBy: { line: "asc" } }, expenses: true },
    });
    if (!issue) return null;
    issue.details.forEach((d) => this.detOrig.set(d.id, pick(d, ISSUE_DETAIL_FIELDS)));
    await this.loadLots(issue.details.map((d) => d.stockDetailsId));
    this.issues.set(issueId, issue);
    return issue;
  }

  /** Change an issue header now (and keep the loaded copy in step). */
  async updateIssue(issue, data) {
    Object.assign(issue, data);
    await this.tx.productIssue.update({ where: { id: issue.id }, data });
    return issue;
  }

  /** Drop an issue from the work (before deleting it). */
  forgetIssue(issueId) {
    const issue = this.issues.get(issueId);
    if (issue) issue.details.forEach((d) => this.detOrig.delete(d.id));
    this.issues.delete(issueId);
  }

  /* ---------------- write ---------------- */
  async flush() {
    const touched = new Set(this.dirtySkus);

    for (const [id, lot] of this.lots) {
      if (this.deletedLots.has(id)) continue;
      const orig = this.lotOrig.get(id);
      const data = {};
      LOT_FIELDS.forEach((f) => {
        if (!same(orig[f], lot[f])) data[f] = DATE_FIELDS.has(f) ? toDate(lot[f]) : lot[f];
      });
      if (!Object.keys(data).length) continue;
      if (lotAvailable(lot) < -0.0005) {
        fail(`${this.pName(lot.productId)}: lot #${lot.seq} would go below zero stock`);
      }
      await this.tx.stockDetails.update({ where: { id }, data });
      touched.add(lot.stockSummaryId);
      if (orig.stockSummaryId !== lot.stockSummaryId) touched.add(orig.stockSummaryId);
      this.lotOrig.set(id, pick(lot, LOT_FIELDS));
    }

    if (this.deletedLots.size) {
      const ids = [...this.deletedLots];
      await this.tx.stockDetails.deleteMany({ where: { ...this.where, id: { in: ids } } });
      ids.forEach((id) => {
        const lot = this.lots.get(id);
        if (lot) touched.add(lot.stockSummaryId);
        this.lots.delete(id);
        this.lotOrig.delete(id);
      });
      this.deletedLots.clear();
    }

    for (const issue of this.issues.values()) {
      for (const d of issue.details) {
        const orig = this.detOrig.get(d.id);
        if (!orig) continue;
        const data = {};
        ISSUE_DETAIL_FIELDS.forEach((f) => {
          if (!same(orig[f], d[f])) data[f] = d[f];
        });
        if (!Object.keys(data).length) continue;
        await this.tx.productIssueDetails.update({ where: { id: d.id }, data });
        this.detOrig.set(d.id, pick(d, ISSUE_DETAIL_FIELDS));
      }
    }

    for (const skuId of touched) {
      if (this.deletedSkus.has(skuId) || !this.skus.has(skuId)) continue;
      this.recalc(skuId);
      const sku = this.skus.get(skuId);
      await this.tx.stockSummary.update({
        where: { id: skuId },
        data: { stockQuantity: sku.stockQuantity, soldQuantity: sku.soldQuantity, issuedQuantity: sku.issuedQuantity },
      });
    }
    this.dirtySkus.clear();

    if (this.deletedSkus.size) {
      const ids = [...this.deletedSkus];
      await this.tx.stockSummary.deleteMany({ where: { ...this.where, id: { in: ids } } });
      ids.forEach((id) => {
        this.skus.delete(id);
        this.loadedSkus.delete(id);
      });
      this.deletedSkus.clear();
    }
  }
}

/* ------------------------------------------------------------------ */
/* Discounts end on their own                                          */
/* ------------------------------------------------------------------ */

/**
 * Ends discounts whose last day has passed and moves stock left in ended discount SKUs back to
 * the regular SKU (also stock that comes back later, e.g. a sales return of issued discount stock).
 */
const sweepDiscounts = async (work) => {
  const { tx } = work;
  let changed = false;
  const expired = await tx.discount.findMany({
    where: { ...work.where, status: "active", endDate: { lt: toDate(today()) } },
    select: { id: true, endDate: true },
  });
  for (const d of expired) {
    await tx.discount.update({
      where: { id: d.id },
      data: { status: "ended", endedAt: dayjs(d.endDate).endOf("day").toISOString() },
    });
    changed = true;
  }

  const ended = await tx.discount.findMany({
    where: { ...work.where, status: "ended", skuId: { not: null } },
    select: { id: true, skuId: true, sourceSkuId: true, returnedQuantity: true },
  });
  if (!ended.length) return changed;
  const withStock = new Set(
    (
      await tx.stockSummary.findMany({
        where: { ...work.where, id: { in: ended.map((d) => d.skuId) }, stockQuantity: { gt: 0 } },
        select: { id: true },
      })
    ).map((s) => s.id),
  );

  for (const d of ended.filter((x) => withStock.has(x.skuId))) {
    await work.loadSkus([d.skuId, d.sourceSkuId]);
    const src = work.sku(d.sourceSkuId);
    if (!src) continue;
    let back = 0;
    for (const lot of work.skuLots(d.skuId).filter((l) => lotAvailable(l) > 0)) {
      const av = lotAvailable(lot);
      lot.quantity = r3(lot.quantity - av);
      await work.createLot({
        productId: lot.productId,
        stockSummaryId: src.id,
        purchasePrice: lot.purchasePrice,
        sellingPrice: src.sellingPrice,
        vatPercent: lot.vatPercent,
        quantity: av,
        expiryDate: lot.expiryDate,
        date: lot.date,
        sourceStockDetailsId: lot.id,
      });
      back = r3(back + av);
    }
    if (back > 0) {
      await tx.discount.update({ where: { id: d.id }, data: { returnedQuantity: r3((d.returnedQuantity || 0) + back) } });
      work.recalc(d.skuId);
      work.recalc(src.id);
      changed = true;
    }
  }
  return changed;
};

/** Cheap check outside a transaction: is there anything for sweepDiscounts to do? */
const needsSweep = async (client, storeId) => {
  const expired = await client.discount.count({
    where: { storeId, status: "active", endDate: { lt: toDate(today()) } },
  });
  if (expired) return true;
  const ended = await client.discount.findMany({
    where: { storeId, status: "ended", skuId: { not: null } },
    select: { skuId: true },
  });
  if (!ended.length) return false;
  const count = await client.stockSummary.count({
    where: { storeId, id: { in: ended.map((d) => d.skuId) }, stockQuantity: { gt: 0 } },
  });
  return count > 0;
};

/**
 * One stock transaction: store lock, discount sweep, fn(work), then every lot / SKU change written.
 * Throwing anywhere rolls everything back (all or nothing).
 */
const stockTransaction = (ctx, fn) =>
  storeTransaction(ctx.storeId, async (tx) => {
    const work = new StockWork(tx, ctx);
    await sweepDiscounts(work);
    await work.flush();
    const result = await fn(work);
    await work.flush();
    return result;
  });

/** Before a read: end expired discounts so lists show the right stock. */
const ensureDiscountsSwept = async (client, ctx) => {
  if (await needsSweep(client, ctx.storeId)) {
    await stockTransaction(ctx, async () => null);
  }
};

module.exports = {
  fail,
  lotAvailable,
  fefoFifo,
  allocate,
  nextCounter,
  nextNo,
  StockWork,
  sweepDiscounts,
  needsSweep,
  stockTransaction,
  ensureDiscountsSwept,
};
