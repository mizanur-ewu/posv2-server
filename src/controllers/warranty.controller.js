const dayjs = require("dayjs");
const { logger } = require("../utils/logger");
const { prisma } = require("../config/db");
const apiError = require("../utils/apiError");
const { toDate, tenant, ctxOf, indexBy } = require("../utils/helperFunction");
const { nextNo } = require("../utils/stock/stockWork");

const CLAIM_STATUS = ["received", "at_service", "ready", "delivered", "replaced", "rejected"];
const pLabel = (p) => (p ? (p.variantName ? `${p.name} (${p.variantName})` : p.name) : "—");

/** Serial rows → with product name, stock entry, invoice and customer, and whether the warranty still runs. */
const serialViews = async (storeId, rows) => {
  const ids = (k) => [...new Set(rows.map((r) => r[k]).filter(Boolean))];
  const [products, stocks, invoices, customers] = await Promise.all([
    prisma.product.findMany({ where: { storeId, id: { in: ids("productId") } }, select: { id: true, name: true, variantName: true, warrantyMonths: true, warrantyNote: true } }),
    prisma.stock.findMany({ where: { storeId, id: { in: ids("stockId") } }, select: { id: true, code: true, date: true, supplierId: true } }),
    prisma.salesInvoice.findMany({ where: { storeId, id: { in: ids("invoiceId") } }, select: { id: true, invoiceNo: true, soldDate: true } }),
    prisma.customer.findMany({ where: { storeId, id: { in: ids("customerId") } }, select: { id: true, name: true, phone: true } }),
  ]);
  const P = indexBy(products);
  const S = indexBy(stocks);
  const I = indexBy(invoices);
  const C = indexBy(customers);
  const today = dayjs().format("YYYY-MM-DD");
  return rows.map((r) => ({
    ...r,
    productName: pLabel(P.get(r.productId)),
    warrantyMonths: P.get(r.productId)?.warrantyMonths || 0,
    warrantyNote: P.get(r.productId)?.warrantyNote || null,
    stockCode: S.get(r.stockId)?.code || null,
    receivedDate: S.get(r.stockId)?.date || null,
    invoiceNo: I.get(r.invoiceId)?.invoiceNo || null,
    customerName: C.get(r.customerId)?.name || (r.invoiceId ? "Walk-in customer" : null),
    customerPhone: C.get(r.customerId)?.phone || null,
    inWarranty: r.status === "sold" && !!r.warrantyUntil && r.warrantyUntil >= today,
  }));
};

/** Find a unit by IMEI / serial (exact first, then "contains"). */
exports.lookup = async (req, res, next) => {
  try {
    const q = String(req.query.q || "").trim();
    if (q.length < 3) throw apiError.badRequest("Type at least 3 characters of the IMEI / serial");
    const where = { storeId: req.storeId };
    let rows = await prisma.serialNumber.findMany({ where: { ...where, serial: { equals: q, mode: "insensitive" } } });
    if (!rows.length) rows = await prisma.serialNumber.findMany({ where: { ...where, serial: { contains: q, mode: "insensitive" } }, take: 20 });
    const views = await serialViews(req.storeId, rows);
    const claims = rows.length ? await prisma.warrantyClaim.findMany({ where: { ...where, serialId: { in: rows.map((r) => r.id) } }, orderBy: { createdAt: "desc" } }) : [];
    return res.status(200).json({ status: "success", data: views.map((v) => ({ ...v, claims: claims.filter((c) => c.serialId === v.id) })) });
  } catch (error) {
    next(error);
  }
};

/** The IMEI register. ?productId= ?status= ?q= */
exports.listSerials = async (req, res, next) => {
  try {
    const where = { storeId: req.storeId };
    if (req.query.productId) where.productId = req.query.productId;
    if (req.query.status) where.status = req.query.status;
    if (req.query.q) where.serial = { contains: String(req.query.q).trim(), mode: "insensitive" };
    const rows = await prisma.serialNumber.findMany({ where, orderBy: { updatedAt: "desc" }, take: 2000 });
    return res.status(200).json({ status: "success", data: await serialViews(req.storeId, rows) });
  } catch (error) {
    next(error);
  }
};

/** In-stock serials of a product (POS and stock-out pickers). */
exports.available = async (req, res, next) => {
  try {
    if (!req.query.productId) throw apiError.badRequest("Select a product");
    const rows = await prisma.serialNumber.findMany({
      where: { storeId: req.storeId, productId: req.query.productId, status: "in_stock" },
      orderBy: { createdAt: "asc" },
      select: { id: true, serial: true, stockId: true, createdAt: true },
    });
    return res.status(200).json({ status: "success", data: rows });
  } catch (error) {
    next(error);
  }
};

/** Serials sold on an invoice (customer return picker). */
exports.soldOnInvoice = async (req, res, next) => {
  try {
    const rows = await prisma.serialNumber.findMany({
      where: { storeId: req.storeId, invoiceId: req.params.invoiceId },
      orderBy: { serial: "asc" },
      select: { id: true, serial: true, productId: true, status: true, warrantyUntil: true },
    });
    return res.status(200).json({ status: "success", data: rows });
  } catch (error) {
    next(error);
  }
};

/* ---------------- warranty claims ---------------- */
exports.listClaims = async (req, res, next) => {
  try {
    const where = { storeId: req.storeId };
    if (req.query.status === "open") where.status = { in: ["received", "at_service", "ready"] };
    else if (CLAIM_STATUS.includes(req.query.status)) where.status = req.query.status;
    const [rows, users] = await Promise.all([
      prisma.warrantyClaim.findMany({ where, orderBy: { createdAt: "desc" }, take: 1000 }),
      prisma.user.findMany({ where: { storeId: req.storeId }, select: { id: true, name: true } }),
    ]);
    const U = indexBy(users);
    return res.status(200).json({ status: "success", data: rows.map((r) => ({ ...r, createdBy: U.get(r.createdById)?.name || "—" })) });
  } catch (error) {
    next(error);
  }
};

/**
 * Take a unit in for warranty. Body: { serial | serialId, problem, customerName?, customerPhone?, receivedDate?, note? }.
 * A unit not in the register (bought elsewhere, or before IMEI tracking) can be taken with productName.
 */
exports.createClaim = async (req, res, next) => {
  try {
    const b = req.body;
    const problem = String(b.problem || "").trim();
    if (!problem) throw apiError.badRequest("Write the problem");
    const where = { storeId: req.storeId };
    let serial = null;
    if (b.serialId) serial = await prisma.serialNumber.findFirst({ where: { ...where, id: b.serialId } });
    else if (b.serial) serial = await prisma.serialNumber.findFirst({ where: { ...where, serial: { equals: String(b.serial).trim(), mode: "insensitive" } } });
    const product = serial ? await prisma.product.findFirst({ where: { ...where, id: serial.productId } }) : null;
    const customer = serial?.customerId ? await prisma.customer.findFirst({ where: { ...where, id: serial.customerId } }) : null;
    const productName = product ? pLabel(product) : String(b.productName || "").trim();
    if (!productName) throw apiError.badRequest("Enter the IMEI / serial, or the product name");
    const claim = await prisma.$transaction(async (tx) =>
      tx.warrantyClaim.create({
        data: {
          ...tenant(req),
          claimNo: await nextNo(tx, ctxOf(req), "WC"),
          serialId: serial?.id || null,
          serial: serial?.serial || (b.serial ? String(b.serial).trim() : null),
          productId: product?.id || null,
          productName,
          invoiceId: serial?.invoiceId || null,
          customerName: String(b.customerName || customer?.name || "").trim() || null,
          customerPhone: String(b.customerPhone || customer?.phone || "").trim() || null,
          problem,
          status: "received",
          receivedDate: toDate(b.receivedDate || dayjs()),
          note: b.note ? String(b.note).trim() : null,
          createdById: req.user.id,
        },
      }),
    );
    return res.status(201).json({ status: "success", message: `Claim ${claim.claimNo} saved`, data: claim });
  } catch (error) {
    logger.error(`Warranty claim error: ${error.message}`);
    next(error);
  }
};

/** Move a claim on: status, note. Delivered / replaced / rejected sets the delivered date. */
exports.updateClaim = async (req, res, next) => {
  try {
    const c = await prisma.warrantyClaim.findFirst({ where: { id: req.params.id, storeId: req.storeId } });
    if (!c) throw apiError.notFound("Claim not found");
    const data = {};
    if (req.body.status) {
      if (!CLAIM_STATUS.includes(req.body.status)) throw apiError.badRequest("Select a status");
      data.status = req.body.status;
      data.deliveredDate = ["delivered", "replaced", "rejected"].includes(req.body.status) ? toDate(req.body.deliveredDate || dayjs()) : null;
    }
    if (req.body.note !== undefined) data.note = req.body.note ? String(req.body.note).trim() : null;
    if (req.body.problem !== undefined && String(req.body.problem).trim()) data.problem = String(req.body.problem).trim();
    const saved = await prisma.warrantyClaim.update({ where: { id: c.id }, data });
    return res.status(200).json({ status: "success", message: "Claim updated", data: saved });
  } catch (error) {
    next(error);
  }
};
