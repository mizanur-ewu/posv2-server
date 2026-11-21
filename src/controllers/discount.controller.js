const { logger } = require("../utils/logger");
const { prisma } = require("../config/db");
const { r2, ctxOf } = require("../utils/helperFunction");
const { stockTransaction, ensureDiscountsSwept } = require("../utils/stock/stockWork");
const { createDiscount, updateDiscount, endDiscount } = require("../utils/stock/adjustment");
const { loadLookups, discountLabel } = require("../utils/viewHelper");

exports.getAllDiscounts = async (req, res, next) => {
  try {
    await ensureDiscountsSwept(prisma, ctxOf(req));
    const L = await loadLookups(prisma, req.storeId);
    const list = [...L.discounts.values()].sort((a, b) => b.createdAt.localeCompare(a.createdAt));
    const data = list.map((d) => {
      const sku = L.skus.get(d.skuId);
      const remaining = sku?.stockQuantity || 0;
      const issued = sku?.issuedQuantity || 0;
      const sold = sku?.soldQuantity || 0;
      return {
        ...d,
        ...L.pInfo(d.productId),
        sku: sku?.sku,
        sourceSku: L.skus.get(d.sourceSkuId)?.sku,
        status: d.status === "ended" ? "ended" : remaining <= 0 && issued <= 0 ? "sold_out" : "active",
        remaining,
        issued,
        soldQuantity: sold,
        given: r2(sold * d.perUnit),
        label: `${discountLabel(d)}${d.mode === "percentage" && d.cappedAt ? ` (max ৳${d.cappedAt})` : ""}`,
        createdBy: L.uName(d.createdById),
      };
    });
    return res.status(200).json({ status: "success", results: data.length, data });
  } catch (error) {
    logger.error(`Discounts retrieval error: ${error.message}`);
    next(error);
  }
};

exports.createDiscount = async (req, res, next) => {
  try {
    const discount = await stockTransaction(ctxOf(req), (work) => createDiscount(work, req.body));
    return res.status(201).json({ status: "success", message: "Discount started", data: discount });
  } catch (error) {
    logger.error(`Discount creation error: ${error.message}`);
    next(error);
  }
};

exports.updateDiscount = async (req, res, next) => {
  try {
    const discount = await stockTransaction(ctxOf(req), (work) => updateDiscount(work, req.params.id, req.body));
    return res.status(200).json({ status: "success", message: "Discount updated", data: discount });
  } catch (error) {
    logger.error(`Discount update error: ${error.message}`);
    next(error);
  }
};

exports.endDiscount = async (req, res, next) => {
  try {
    const discount = await stockTransaction(ctxOf(req), (work) => endDiscount(work, req.params.id));
    return res.status(200).json({ status: "success", message: "Discount ended", data: discount });
  } catch (error) {
    logger.error(`Discount end error: ${error.message}`);
    next(error);
  }
};
