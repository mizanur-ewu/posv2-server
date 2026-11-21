const { logger } = require("../utils/logger");
const { prisma } = require("../config/db");
const apiError = require("../utils/apiError");
const { r3, ctxOf, indexBy, boolParam } = require("../utils/helperFunction");
const {
  stockTransaction,
  ensureDiscountsSwept,
  lotAvailable,
  fefoFifo,
} = require("../utils/stock/stockWork");
const {
  splitOutQty,
  lotMinQty,
  stockTotalsFrom,
  usedLotIds,
  stockChecks,
  stockDeleteBlockReason,
  priceChangeConflict,
  createStock,
  updateStock,
  deleteStock,
} = require("../utils/stock/stockEntry");
const { loadLookups, skuViews, skuView } = require("../utils/viewHelper");

/** Entry lots (own + split) grouped by stock entry. */
const groupByRoot = (lots) => {
  const map = new Map();
  lots.forEach((l) => {
    if (!map.has(l.rootStockId)) map.set(l.rootStockId, []);
    map.get(l.rootStockId).push(l);
  });
  return map;
};

/* ---------------- stock entry ---------------- */
exports.getAllStock = async (req, res, next) => {
  try {
    await ensureDiscountsSwept(prisma, ctxOf(req));
    const where = { storeId: req.storeId };
    const [stocks, lots, payments, returns, suppliers, users, products] =
      await Promise.all([
        prisma.stock.findMany({ where }),
        prisma.stockDetails.findMany({
          where: { ...where, rootStockId: { not: null } },
        }),
        prisma.supplierPayment.findMany({
          where: { ...where, stockId: { not: null } },
        }),
        prisma.stockAdjustment.findMany({
          where: { ...where, adjustmentType: "supplier_return" },
        }),
        prisma.supplier.findMany({ where, select: { id: true, name: true } }),
        prisma.user.findMany({ where, select: { id: true, name: true } }),
        prisma.product.findMany({ where, select: { id: true, name: true } }),
      ]);
    const S = indexBy(suppliers);
    const U = indexBy(users);
    const P = indexBy(products);
    const byStock = groupByRoot(lots);
    stocks.forEach((s) => byStock.has(s.id) || byStock.set(s.id, []));
    const checks = await stockChecks(
      prisma,
      req.storeId,
      byStock,
      (id) => P.get(id)?.name || "Product",
    );

    const data = stocks
      .map((s) => {
        const entryLots = byStock.get(s.id) || [];
        const lotIds = new Set(entryLots.map((l) => l.id));
        const check = checks.get(s.id);
        return {
          ...s,
          supplier: S.get(s.supplierId)?.name || "—",
          createdBy: U.get(s.createdById)?.name || "—",
          ...stockTotalsFrom({
            stock: s,
            entryLots,
            payments: payments.filter((p) => p.stockId === s.id),
            returns: returns.filter((a) => lotIds.has(a.stockDetailsId)),
          }),
          canDelete: !check.blockers.length,
          deleteBlockReason: stockDeleteBlockReason(check),
          // removed together with the entry (shown in the delete confirm)
          deleteCascade: check.cascade,
          available: r3(
            entryLots.reduce((a, l) => a + Math.max(0, lotAvailable(l)), 0),
          ),
        };
      })
      .sort(
        (a, b) => b.date.localeCompare(a.date) || b.code.localeCompare(a.code),
      );

    return res
      .status(200)
      .json({ status: "success", results: data.length, data });
  } catch (error) {
    logger.error(`Stock list error: ${error.message}`);
    next(error);
  }
};

exports.getStockById = async (req, res, next) => {
  try {
    await ensureDiscountsSwept(prisma, ctxOf(req));
    const id = req.params.id;
    const s = await prisma.stock.findFirst({
      where: { id, storeId: req.storeId },
    });
    if (!s) throw apiError.notFound("Stock entry not found");
    const [L, entryLots, payments, returns, supplier, user] = await Promise.all(
      [
        loadLookups(prisma, req.storeId),
        prisma.stockDetails.findMany({
          where: { storeId: req.storeId, rootStockId: id },
          orderBy: { seq: "asc" },
        }),
        prisma.supplierPayment.findMany({
          where: { storeId: req.storeId, stockId: id },
          orderBy: { createdAt: "asc" },
        }),
        prisma.stockAdjustment.findMany({
          where: { storeId: req.storeId, adjustmentType: "supplier_return" },
        }),
        s.supplierId
          ? prisma.supplier.findUnique({
              where: { id: s.supplierId },
              select: { name: true },
            })
          : null,
        prisma.user.findUnique({
          where: { id: s.createdById },
          select: { name: true },
        }),
      ],
    );
    const lotIds = new Set(entryLots.map((l) => l.id));
    const own = entryLots.filter((l) => l.stockId === id);
    const used = await usedLotIds(prisma, req.storeId, own, entryLots);

    const data = {
      ...s,
      supplier: supplier?.name || "—",
      createdBy: user?.name || "—",
      ...stockTotalsFrom({
        stock: s,
        entryLots,
        payments,
        returns: returns.filter((a) => lotIds.has(a.stockDetailsId)),
      }),
      details: own.map((l) => ({
        ...l,
        ...L.pInfo(l.productId),
        sku: L.skuCode(l.stockSummaryId),
        receivedQty: r3(l.quantity + splitOutQty(l, entryLots)),
        repricedQty: splitOutQty(l, entryLots),
        available: lotAvailable(l),
        used: used.has(l.id),
        minQty: lotMinQty(l, entryLots),
      })),
      // own lots + repriced / discount split lots: what can still be returned or adjusted
      lots: entryLots.map((l) => {
        const sku = L.skus.get(l.stockSummaryId);
        return {
          ...l,
          ...L.pInfo(l.productId),
          sku: sku?.sku,
          discount: L.skuDiscount(sku),
          split: !l.stockId,
          available: lotAvailable(l),
        };
      }),
      payments: payments.map((p) => ({
        ...p,
        method: L.method(p.paymentMethodId),
      })),
    };
    return res.status(200).json({ status: "success", data });
  } catch (error) {
    logger.error(`Stock retrieval error: ${error.message}`);
    next(error);
  }
};

exports.createStock = async (req, res, next) => {
  try {
    const stock = await stockTransaction(ctxOf(req), (work) =>
      createStock(work, req.body),
    );
    logger.info(`Stock entry ${stock.code} created by ${req.user.id}`);
    return res
      .status(201)
      .json({ status: "success", message: "Stock entry saved", data: stock });
  } catch (error) {
    logger.error(`Stock creation error: ${error.message}`);
    next(error);
  }
};

exports.updateStock = async (req, res, next) => {
  try {
    const stock = await stockTransaction(ctxOf(req), (work) =>
      updateStock(work, req.params.id, req.body),
    );
    return res
      .status(200)
      .json({ status: "success", message: "Stock entry updated", data: stock });
  } catch (error) {
    logger.error(`Stock update error: ${error.message}`);
    next(error);
  }
};

exports.deleteStock = async (req, res, next) => {
  try {
    const result = await stockTransaction(ctxOf(req), (work) =>
      deleteStock(work, req.params.id),
    );
    logger.info(`Stock entry ${result.code} deleted by ${req.user.id}`);
    return res
      .status(200)
      .json({
        status: "success",
        message: "Stock entry deleted",
        data: result,
      });
  } catch (error) {
    logger.error(`Stock delete error: ${error.message}`);
    next(error);
  }
};

/** Lines whose selling price change needs the reprice popup. */
exports.checkPriceConflicts = async (req, res, next) => {
  try {
    const lines = Array.isArray(req.body.lines) ? req.body.lines : [];
    const products = indexBy(
      await prisma.product.findMany({
        where: { storeId: req.storeId },
        select: { id: true, name: true },
      }),
    );
    const data = [];
    for (const [idx, l] of lines.entries()) {
      if (!l?.productId) continue;
      const c = await priceChangeConflict(
        prisma,
        req.storeId,
        l.productId,
        l.purchasePrice,
        l.sellingPrice,
      );
      if (c)
        data.push({
          ...c,
          lineIndex: idx,
          productName: products.get(l.productId)?.name || "—",
        });
    }
    return res.status(200).json({ status: "success", data });
  } catch (error) {
    logger.error(`Price conflict check error: ${error.message}`);
    next(error);
  }
};

/* ---------------- SKU / lots ---------------- */
exports.getSkus = async (req, res, next) => {
  try {
    console.log("first");
    await ensureDiscountsSwept(prisma, ctxOf(req));
    const L = await loadLookups(prisma, req.storeId, { lots: true });
    const onlyAvailable = boolParam(req.query.onlyAvailable);
    const data = skuViews(
      L,
      L.skuList.filter((s) => !onlyAvailable || s.stockQuantity > 0),
    );
    return res
      .status(200)
      .json({ status: "success", results: data.length, data });
  } catch (error) {
    logger.error(`SKU list error: ${error.message}`);
    next(error);
  }
};

exports.getLots = async (req, res, next) => {
  try {
    const skuId = req.params.id;
    const lots = await prisma.stockDetails.findMany({
      where: { storeId: req.storeId, stockSummaryId: skuId },
    });
    const related = await prisma.stockDetails.findMany({
      where: {
        id: { in: lots.map((l) => l.sourceStockDetailsId).filter(Boolean) },
      },
      select: { id: true, seq: true },
    });
    const stocks = await prisma.stock.findMany({
      where: { id: { in: lots.map((l) => l.stockId).filter(Boolean) } },
      select: { id: true, code: true },
    });
    const R = indexBy(related);
    const ST = indexBy(stocks);
    const data = lots.sort(fefoFifo).map((l) => ({
      ...l,
      available: lotAvailable(l),
      stockCode: ST.get(l.stockId)?.code || null,
      sourceLot: l.sourceStockDetailsId
        ? `Split from lot #${R.get(l.sourceStockDetailsId)?.seq}`
        : null,
    }));
    return res.status(200).json({ status: "success", data });
  } catch (error) {
    logger.error(`Lot list error: ${error.message}`);
    next(error);
  }
};

/** Barcode / SKU-code scanner lookup (POS and stock entry). */
exports.lookupCode = async (req, res, next) => {
  try {
    const c = String(req.query.code || "").trim();
    if (!c)
      return res
        .status(200)
        .json({ status: "success", data: { type: "none" } });
    const where = { storeId: req.storeId };
    const sku = await prisma.stockSummary.findFirst({
      where: { ...where, sku: { equals: c, mode: "insensitive" } },
    });
    let product = sku
      ? null
      : await prisma.product.findFirst({
          where: {
            ...where,
            OR: [{ barcode: c }, { code: { equals: c, mode: "insensitive" } }],
          },
        });
    const serial =
      sku || product
        ? null
        : await prisma.serialNumber.findFirst({ where: { ...where, serial: { equals: c, mode: "insensitive" } } });
    if (serial) {
      if (serial.status !== "in_stock") {
        return res.status(200).json({ status: "success", data: { type: "serial_unavailable", serial: serial.serial, serialStatus: serial.status } });
      }
      product = await prisma.product.findFirst({ where: { ...where, id: serial.productId } });
    }
    if (!sku && !product)
      return res
        .status(200)
        .json({ status: "success", data: { type: "none" } });

    const L = await loadLookups(prisma, req.storeId);
    const skus = sku
      ? [sku]
      : L.skuList.filter(
          (s) => s.productId === product.id && s.stockQuantity > 0,
        );
    const lots = skus.length
      ? await prisma.stockDetails.findMany({
          where: { ...where, stockSummaryId: { in: skus.map((s) => s.id) } },
        })
      : [];
    const views = skus.map((s) =>
      skuView(
        L,
        s,
        lots.filter((l) => l.stockSummaryId === s.id),
      ),
    );
    const data = sku
      ? { type: "sku", skus: views }
      : serial
        ? { type: "serial", serial: serial.serial, product, skus: views }
        : { type: "product", product, skus: views };
    return res.status(200).json({ status: "success", data });
  } catch (error) {
    logger.error(`Code lookup error: ${error.message}`);
    next(error);
  }
};
