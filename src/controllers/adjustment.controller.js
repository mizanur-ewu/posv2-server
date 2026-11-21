const { logger } = require("../utils/logger");
const { prisma } = require("../config/db");
const { r2, ctxOf, indexBy } = require("../utils/helperFunction");
const { stockTransaction, lotAvailable } = require("../utils/stock/stockWork");
const {
  ADJUSTMENT_TYPES,
  createAdjustment,
  adjustStockEntry,
  updateAdjustment,
  deleteAdjustment,
} = require("../utils/stock/adjustment");
const { loadLookups } = require("../utils/viewHelper");

exports.getAdjustmentTypes = async (req, res, next) => {
  try {
    return res.status(200).json({ status: "success", data: ADJUSTMENT_TYPES });
  } catch (error) {
    next(error);
  }
};

/** Every stock adjustment (manual and sales return shortages), newest first. */
exports.getAllAdjustments = async (req, res, next) => {
  try {
    const where = { storeId: req.storeId };
    const [L, adjustments, suppliers, issues, stocks] = await Promise.all([
      loadLookups(prisma, req.storeId),
      prisma.stockAdjustment.findMany({ where }),
      prisma.supplier.findMany({ where, select: { id: true, name: true } }),
      prisma.productIssue.findMany({ where, select: { id: true, issueNo: true } }),
      prisma.stock.findMany({ where, select: { id: true, code: true } }),
    ]);
    const lots = indexBy(
      await prisma.stockDetails.findMany({ where: { id: { in: [...new Set(adjustments.map((a) => a.stockDetailsId))] } } }),
    );
    const S = indexBy(suppliers);
    const I = indexBy(issues);
    const ST = indexBy(stocks);

    const data = adjustments
      .map((a) => {
        const lot = lots.get(a.stockDetailsId);
        const sku = L.skus.get(a.stockSummaryId || lot?.stockSummaryId);
        return {
          ...a,
          direction: a.direction || "out",
          ...L.pInfo(lot?.productId || sku?.productId),
          stockId: lot?.rootStockId || null,
          stockCode: lot?.rootStockId ? ST.get(lot.rootStockId)?.code || null : null,
          lotAvailable: lot ? lotAvailable(lot) : 0,
          manual: a.adjustmentType !== "shortage",
          sku: sku?.sku,
          sellingPrice: sku?.sellingPrice,
          lotNo: lot?.seq,
          expiryDate: lot?.expiryDate,
          purchasePrice: lot?.purchasePrice,
          costValue: r2(a.quantity * (lot?.purchasePrice || 0)),
          supplier: a.supplierId ? S.get(a.supplierId)?.name : null,
          employee: a.employeeId ? L.eName(a.employeeId) : null,
          issueNo: a.issueId ? I.get(a.issueId)?.issueNo : null,
          createdBy: L.uName(a.createdById),
        };
      })
      .sort((a, b) => b.date.localeCompare(a.date) || (b.createdAt || "").localeCompare(a.createdAt || ""));

    return res.status(200).json({ status: "success", results: data.length, data });
  } catch (error) {
    logger.error(`Adjustments retrieval error: ${error.message}`);
    next(error);
  }
};

exports.createAdjustment = async (req, res, next) => {
  try {
    const result = await stockTransaction(ctxOf(req), (work) => createAdjustment(work, req.body));
    return res.status(201).json({ status: "success", message: "Adjustment saved", data: result });
  } catch (error) {
    logger.error(`Adjustment creation error: ${error.message}`);
    next(error);
  }
};

/** Return / adjust the lots of one stock entry. */
exports.adjustStockEntry = async (req, res, next) => {
  try {
    const result = await stockTransaction(ctxOf(req), (work) => adjustStockEntry(work, req.body));
    return res.status(201).json({ status: "success", message: "Adjustment saved", data: result });
  } catch (error) {
    logger.error(`Stock entry adjustment error: ${error.message}`);
    next(error);
  }
};

exports.updateAdjustment = async (req, res, next) => {
  try {
    const result = await stockTransaction(ctxOf(req), (work) => updateAdjustment(work, req.params.id, req.body));
    return res.status(200).json({ status: "success", message: "Adjustment updated", data: result });
  } catch (error) {
    logger.error(`Adjustment update error: ${error.message}`);
    next(error);
  }
};

exports.deleteAdjustment = async (req, res, next) => {
  try {
    const result = await stockTransaction(ctxOf(req), (work) => deleteAdjustment(work, req.params.id));
    return res.status(200).json({ status: "success", message: "Adjustment deleted", data: result });
  } catch (error) {
    logger.error(`Adjustment delete error: ${error.message}`);
    next(error);
  }
};
