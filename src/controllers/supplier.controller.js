const { logger } = require("../utils/logger");
const { prisma } = require("../config/db");
const apiError = require("../utils/apiError");
const { r2, toDate, tenant, indexBy } = require("../utils/helperFunction");
const { stockTotalsFrom } = require("../utils/stock/stockEntry");

const supplierFields = (body) => {
  const clean = {
    name: String(body.name || "").trim(),
    phone: body.phone ? String(body.phone).trim() : null,
    email: body.email ? String(body.email).trim() : null,
    address: body.address ? String(body.address).trim() : null,
  };
  if (!clean.name) throw apiError.badRequest("Supplier name is required");
  return clean;
};

exports.createSupplier = async (req, res, next) => {
  try {
    const clean = supplierFields(req.body);
    const supplier = await prisma.supplier.create({ data: { ...tenant(req), ...clean } });
    return res.status(201).json({ status: "success", message: "Supplier created successfully", data: supplier });
  } catch (error) {
    logger.error(`Supplier creation error: ${error.message}`);
    next(error);
  }
};

exports.updateSupplier = async (req, res, next) => {
  try {
    const id = req.params.id;
    if (!(await prisma.supplier.findFirst({ where: { id, storeId: req.storeId } }))) throw apiError.notFound("Supplier not found");
    const supplier = await prisma.supplier.update({ where: { id }, data: supplierFields(req.body) });
    return res.status(200).json({ status: "success", message: "Supplier updated successfully", data: supplier });
  } catch (error) {
    logger.error(`Supplier update error: ${error.message}`);
    next(error);
  }
};

/** Every supplier payment, newest first. */
exports.getSupplierPayments = async (req, res, next) => {
  try {
    const where = { storeId: req.storeId };
    const [payments, suppliers, stocks, users, methods] = await Promise.all([
      prisma.supplierPayment.findMany({ where, orderBy: [{ date: "desc" }, { createdAt: "desc" }] }),
      prisma.supplier.findMany({ where, select: { id: true, name: true } }),
      prisma.stock.findMany({ where, select: { id: true, code: true } }),
      prisma.user.findMany({ where, select: { id: true, name: true } }),
      prisma.paymentMethod.findMany(),
    ]);
    const S = indexBy(suppliers);
    const ST = indexBy(stocks);
    const U = indexBy(users);
    const M = indexBy(methods);
    const data = payments.map((p) => ({
      ...p,
      supplier: S.get(p.supplierId)?.name || "—",
      stockCode: ST.get(p.stockId)?.code || null,
      method: M.get(p.paymentMethodId)?.name,
      createdBy: U.get(p.createdById)?.name || "—",
    }));
    return res.status(200).json({ status: "success", data });
  } catch (error) {
    logger.error(`Supplier payments retrieval error: ${error.message}`);
    next(error);
  }
};

/** Value (with VAT) of each stock entry: Map stockId → total. `stocks` limits it to those entries. */
const stockEntryTotals = async (client, storeId, stocks) => {
  const lots = await client.stockDetails.findMany({
    where: { storeId, rootStockId: stocks ? { in: stocks.map((s) => s.id) } : { not: null } },
    select: { id: true, stockId: true, rootStockId: true, quantity: true, purchasePrice: true, sourceStockDetailsId: true },
  });
  const lotsOf = new Map();
  lots.forEach((l) => {
    if (!lotsOf.has(l.rootStockId)) lotsOf.set(l.rootStockId, []);
    lotsOf.get(l.rootStockId).push(l);
  });
  return (s) => stockTotalsFrom({ stock: s, entryLots: lotsOf.get(s.id) || [], payments: [], returns: [] }).total;
};

/** Purchase, returns, payments and due per supplier (also used by the dashboard). */
const supplierDueRows = async (client, storeId) => {
  const where = { storeId };
  const [suppliers, stocks, payments, returns] = await Promise.all([
    client.supplier.findMany({ where, orderBy: { name: "asc" } }),
    client.stock.findMany({ where }),
    client.supplierPayment.findMany({ where }),
    client.stockAdjustment.findMany({ where: { ...where, adjustmentType: "supplier_return" } }),
  ]);
  const stockTotal = await stockEntryTotals(client, storeId);
  return suppliers.map((sup) => {
    const own = stocks.filter((s) => s.supplierId === sup.id);
    const purchase = r2(own.reduce((a, s) => a + stockTotal(s), 0));
    const paid = r2(payments.filter((p) => p.supplierId === sup.id).reduce((a, p) => a + p.amount, 0));
    const returned = r2(returns.filter((a) => a.supplierId === sup.id).reduce((a, x) => a + x.amount, 0));
    return { ...sup, purchase, returned, paid, due: r2(purchase - returned - paid), entries: own.length };
  });
};

/** Purchase, returns, payments and due per supplier. */
exports.getSupplierDues = async (req, res, next) => {
  try {
    const data = await supplierDueRows(prisma, req.storeId);
    return res.status(200).json({ status: "success", data });
  } catch (error) {
    logger.error(`Supplier dues retrieval error: ${error.message}`);
    next(error);
  }
};

/** Pay a supplier, against a stock entry (stockId) or against the old due. */
exports.addSupplierPayment = async (req, res, next) => {
  try {
    const { supplierId, stockId, amount, paymentMethodId, date, remark } = req.body;
    const amt = r2(amount);
    if (!(amt > 0)) throw apiError.badRequest("Enter an amount");
    if (!paymentMethodId || !(await prisma.paymentMethod.findUnique({ where: { id: paymentMethodId } }))) {
      throw apiError.badRequest("Select a payment method");
    }
    let supplier = supplierId || null;
    if (stockId) {
      const stock = await prisma.stock.findFirst({ where: { id: stockId, storeId: req.storeId } });
      if (!stock) throw apiError.notFound("Stock entry not found");
      supplier = supplier || stock.supplierId;
    }
    if (supplier && !(await prisma.supplier.findFirst({ where: { id: supplier, storeId: req.storeId } }))) {
      throw apiError.notFound("Supplier not found");
    }
    if (!supplier && !stockId) throw apiError.badRequest("Select a supplier");

    const payment = await prisma.supplierPayment.create({
      data: {
        ...tenant(req),
        supplierId: supplier,
        stockId: stockId || null,
        amount: amt,
        paymentMethodId,
        date: toDate(date),
        remark: remark || null,
        createdById: req.user.id,
      },
    });
    return res.status(201).json({ status: "success", message: "Payment recorded successfully", data: payment });
  } catch (error) {
    logger.error(`Supplier payment error: ${error.message}`);
    next(error);
  }
};

module.exports.supplierDueRows = supplierDueRows;
module.exports.stockEntryTotals = stockEntryTotals;
