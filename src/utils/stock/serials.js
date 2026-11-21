const dayjs = require("dayjs");
const { toDate } = require("../helperFunction");
const { fail } = require("./stockWork");

/**
 * IMEI / serial register for products with `trackSerial`.
 * Costing stays FIFO by lot; this register says which exact units are in the shop, sold to whom
 * (with warranty) or gone (damaged / lost / back to supplier). In-stock serials of a product always
 * equal its stock in hand: every stock entry, sale, return and adjustment of such a product names its serials.
 */

/** Typed / scanned serials → trimmed, no blanks, no repeats (repeats are an error). */
const cleanSerials = (list, productName) => {
  const out = (Array.isArray(list) ? list : String(list || "").split(/[\n,;]+/)).map((s) => String(s || "").trim()).filter(Boolean);
  const seen = new Set();
  out.forEach((s) => {
    const k = s.toUpperCase();
    if (seen.has(k)) fail(`${productName ? `${productName}: ` : ""}IMEI / serial ${s} is entered twice`);
    seen.add(k);
  });
  return out;
};

/** Whole number of units, equal to the number of serials. */
const needCount = (qty, serials, productName) => {
  const q = Number(qty);
  if (!Number.isInteger(q)) fail(`${productName}: IMEI / serial products are counted in whole units`);
  if (serials.length !== q) fail(`${productName}: enter ${q} IMEI / serial number(s), ${serials.length} given`);
};

/**
 * New units come in (stock entry or a count gain). A serial that was sold or returned before and
 * comes back is taken in again; one that is already in stock is an error.
 */
const addSerials = async (tx, ctx, { product, serials, quantity, stockId = null, purchasePrice = null, adjustmentRef = null }) => {
  const list = cleanSerials(serials, product.name);
  needCount(quantity, list, product.name);
  const existing = await tx.serialNumber.findMany({ where: { storeId: ctx.storeId, serial: { in: list, mode: "insensitive" } } });
  for (const e of existing) {
    if (e.status === "in_stock") fail(`IMEI / serial ${e.serial} is already in stock`);
  }
  for (const s of list) {
    const old = existing.find((e) => e.serial.toUpperCase() === s.toUpperCase());
    const data = { productId: product.id, stockId, purchasePrice, status: "in_stock", invoiceId: null, customerId: null, soldAt: null, warrantyUntil: null, adjustmentRef, note: null };
    if (old) await tx.serialNumber.update({ where: { id: old.id }, data });
    else await tx.serialNumber.create({ data: { ...data, serial: s, storeId: ctx.storeId, companyId: ctx.companyId } });
  }
  return list;
};

/** The in-stock serial rows for `serials` of one product; exactly `quantity` of them. */
const takeSerials = async (tx, ctx, { product, serials, quantity }) => {
  const list = cleanSerials(serials, product.name);
  needCount(quantity, list, product.name);
  const rows = await tx.serialNumber.findMany({ where: { storeId: ctx.storeId, serial: { in: list, mode: "insensitive" } } });
  for (const s of list) {
    const row = rows.find((r) => r.serial.toUpperCase() === s.toUpperCase());
    if (!row) fail(`IMEI / serial ${s} is not in the register`);
    if (row.productId !== product.id) fail(`IMEI / serial ${s} belongs to another product`);
    if (row.status !== "in_stock") fail(`IMEI / serial ${s} is not in stock (${row.status.replace("_", " ")})`);
  }
  return rows;
};

/** Sold: link to the invoice and customer, start the warranty. */
const markSold = async (tx, rows, { invoiceId, customerId, soldAt, warrantyMonths }) => {
  const until = warrantyMonths > 0 ? toDate(dayjs(soldAt).add(warrantyMonths, "month").subtract(1, "day")) : null;
  await tx.serialNumber.updateMany({
    where: { id: { in: rows.map((r) => r.id) } },
    data: { status: "sold", invoiceId, customerId: customerId || null, soldAt: dayjs(soldAt).toISOString(), warrantyUntil: until },
  });
};

/** Back in stock (customer return, deleted sale, deleted adjustment). */
const backInStock = (tx, where) =>
  tx.serialNumber.updateMany({ where, data: { status: "in_stock", invoiceId: null, customerId: null, soldAt: null, warrantyUntil: null, adjustmentRef: null } });

const OUT_STATUS = { damage: "damaged", expired: "damaged", lost: "lost", supplier_return: "supplier_returned" };

/** Units leaving by an adjustment: damaged, lost or returned to the supplier. */
const markGone = async (tx, rows, type, refNo) => {
  await tx.serialNumber.updateMany({ where: { id: { in: rows.map((r) => r.id) } }, data: { status: OUT_STATUS[type] || "damaged", adjustmentRef: refNo } });
};

module.exports = { cleanSerials, addSerials, takeSerials, markSold, backInStock, markGone, needCount };
