const { logger } = require("../utils/logger");
const { prisma } = require("../config/db");
const { ctxOf, indexBy } = require("../utils/helperFunction");
const { stockTransaction } = require("../utils/stock/stockWork");
const { createReturn } = require("../utils/stock/sales");
const { loadLookups } = require("../utils/viewHelper");

/** Customer returns, newest first. */
exports.getAllReturns = async (req, res, next) => {
  try {
    const where = { storeId: req.storeId };
    const [L, returns] = await Promise.all([
      loadLookups(prisma, req.storeId),
      prisma.salesReturn.findMany({ where, include: { details: true }, orderBy: { returnDate: "desc" } }),
    ]);
    const invoices = indexBy(
      await prisma.salesInvoice.findMany({
        where: { id: { in: [...new Set(returns.map((r) => r.invoiceId))] } },
        select: { id: true, invoiceNo: true, channel: true },
      }),
    );
    const data = returns.map((r) => {
      const inv = invoices.get(r.invoiceId);
      return {
        ...r,
        invoiceNo: inv?.invoiceNo,
        channel: inv?.channel,
        customer: L.cName(r.customerId),
        method: L.method(r.paymentMethodId),
        createdBy: L.uName(r.createdById),
        items: r.details.map((d) => `${L.pName(d.productId)} × ${d.returnQuantity} ${L.pInfo(d.productId).unit}`.trim()).join(", "),
        details: r.details.map((d) => ({ ...d, ...L.pInfo(d.productId), sku: L.skuCode(d.stockSummaryId) })),
      };
    });
    return res.status(200).json({ status: "success", results: data.length, data });
  } catch (error) {
    logger.error(`Returns retrieval error: ${error.message}`);
    next(error);
  }
};

/** Return items of an invoice: stock goes back to the same lot, due first, then refund. */
exports.createReturn = async (req, res, next) => {
  try {
    const ret = await stockTransaction(ctxOf(req), (work) => createReturn(work, req.body));
    logger.info(`Return ${ret.returnNo} created by ${req.user.id}`);
    return res.status(201).json({ status: "success", message: `Return ${ret.returnNo} saved`, data: ret });
  } catch (error) {
    logger.error(`Return creation error: ${error.message}`);
    next(error);
  }
};
