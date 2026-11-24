const dayjs = require("dayjs");
const { logger } = require("../utils/logger");
const { prisma } = require("../config/db");
const apiError = require("../utils/apiError");
const { shopEvent } = require("../services/sms/sms");
const { r2, ctxOf, boolParam } = require("../utils/helperFunction");
const { roleCan } = require("../utils/permissions");
const { stockTransaction } = require("../utils/stock/stockWork");
const { storeTransaction } = require("../utils/storeTransaction");
const { createInvoice, receivePayment, deleteInvoice } = require("../utils/stock/sales");
const { loadLookups, invoiceViews } = require("../utils/viewHelper");

const INVOICE_LIST = { details: true };
const INVOICE_FULL = { details: { orderBy: { line: "asc" } }, payments: { orderBy: { line: "asc" } } };

/** One invoice in its detail shape (lines, grouped lines, payments, returns). */
const invoiceDetailView = async (client, storeId, id) => {
  const inv = await client.salesInvoice.findFirst({ where: { id, storeId }, include: INVOICE_FULL });
  if (!inv) return null;
  const L = await loadLookups(client, storeId);
  return (await invoiceViews(client, L, [inv], { withDetails: true }))[0];
};

/** Sales history. Filters: channel, customerId, from, to, dueOnly. */
exports.getAllInvoices = async (req, res, next) => {
  try {
    const { channel, customerId, from, to, dueOnly } = req.query;
    const where = { storeId: req.storeId };
    if (channel) where.channel = channel;
    if (customerId) where.soldToId = customerId;
    if (from || to) {
      where.soldDate = {};
      if (from) where.soldDate.gte = dayjs(from).startOf("day").toDate();
      if (to) where.soldDate.lte = dayjs(to).endOf("day").toDate();
    }
    if (boolParam(dueOnly)) where.totalDue = { gt: 0 };

    const [L, invoices] = await Promise.all([
      loadLookups(prisma, req.storeId),
      prisma.salesInvoice.findMany({ where, include: INVOICE_LIST, orderBy: { soldDate: "desc" } }),
    ]);
    const data = await invoiceViews(prisma, L, invoices);
    return res.status(200).json({ status: "success", results: data.length, data });
  } catch (error) {
    logger.error(`Invoices retrieval error: ${error.message}`);
    next(error);
  }
};

exports.getInvoiceById = async (req, res, next) => {
  try {
    const data = await invoiceDetailView(prisma, req.storeId, req.params.id);
    if (!data) throw apiError.notFound("Invoice not found");
    return res.status(200).json({ status: "success", data });
  } catch (error) {
    logger.error(`Invoice retrieval error: ${error.message}`);
    next(error);
  }
};

/** Find an invoice by its number (customer returns). null when there is none. */
exports.getInvoiceByNo = async (req, res, next) => {
  try {
    const no = String(req.params.no || "").trim();
    const inv = await prisma.salesInvoice.findFirst({
      where: { storeId: req.storeId, invoiceNo: { equals: no, mode: "insensitive" } },
      select: { id: true },
    });
    const data = inv ? await invoiceDetailView(prisma, req.storeId, inv.id) : null;
    return res.status(200).json({ status: "success", data });
  } catch (error) {
    logger.error(`Invoice lookup error: ${error.message}`);
    next(error);
  }
};

/** POS sale. Changing a price or giving a discount needs those rights on the POS page. */
exports.createPosInvoice = async (req, res, next) => {
  try {
    const { soldToId, lines = [], billDiscount = 0, vatPercent = 0, payments = [] } = req.body;
    if (!Array.isArray(lines) || !lines.length) throw apiError.badRequest("Invoice has no lines");

    const canPrice = roleCan(req.role, req.subscription, "pos", "changePrice");
    const canDiscount = roleCan(req.role, req.subscription, "pos", "discount");
    if (!canDiscount && (Number(billDiscount) > 0 || lines.some((l) => Number(l.discount) > 0))) {
      throw apiError.forbidden("You can't give a discount");
    }
    if (!canPrice) {
      const skus = await prisma.stockSummary.findMany({
        where: { storeId: req.storeId, id: { in: lines.map((l) => l.skuId) } },
        select: { id: true, sellingPrice: true },
      });
      const changed = lines.some((l) => {
        const sku = skus.find((s) => s.id === l.skuId);
        return sku && l.unitPrice != null && r2(l.unitPrice) !== r2(sku.sellingPrice);
      });
      if (changed) throw apiError.forbidden("You can't change the price");
    }

    const store = await prisma.store.findUnique({ where: { id: req.storeId }, select: { allowDue: true } });
    const invoice = await stockTransaction(ctxOf(req), (work) =>
      createInvoice(work, {
        channel: "pos",
        wholeTaka: true,
        allowDue: store?.allowDue !== false,
        soldToId: soldToId || null,
        lines,
        billDiscount: Number(billDiscount) || 0,
        vatPercent: Number(vatPercent) || 0,
        payments: Array.isArray(payments) ? payments : [],
      }),
    );
    const data = await invoiceDetailView(prisma, req.storeId, invoice.id);
    logger.info(`POS invoice ${invoice.invoiceNo} created by ${req.user.id}`);
    // thank-you SMS to a known customer (only if the shop turned it on; queued, never blocks the sale)
    if (invoice.soldToId) {
      const c = await prisma.customer.findUnique({ where: { id: invoice.soldToId }, select: { name: true, phone: true } });
      if (c?.phone) {
        shopEvent(req.storeId, "sale", c.phone, { customer: c.name, invoice: invoice.invoiceNo, amount: invoice.totalAmount, paid: invoice.totalPaid, due: invoice.totalDue });
      }
    }
    return res.status(201).json({ status: "success", message: `Invoice ${invoice.invoiceNo} saved`, data });
  } catch (error) {
    logger.error(`POS invoice error: ${error.message}`);
    next(error);
  }
};

/** Receive due on one invoice. */
exports.receivePayment = async (req, res, next) => {
  try {
    const inv = await storeTransaction(req.storeId, (tx) => receivePayment(tx, ctxOf(req), req.params.id, req.body));
    return res.status(200).json({ status: "success", message: "Payment received", data: inv });
  } catch (error) {
    logger.error(`Invoice payment error: ${error.message}`);
    next(error);
  }
};

/** Delete a POS sale for good (stock goes back to its lots). */
exports.deleteInvoice = async (req, res, next) => {
  try {
    const result = await stockTransaction(ctxOf(req), (work) => deleteInvoice(work, req.params.id));
    logger.info(`Invoice ${result.invoiceNo} deleted by ${req.user.id}`);
    return res.status(200).json({ status: "success", message: `${result.invoiceNo} deleted`, data: result });
  } catch (error) {
    logger.error(`Invoice delete error: ${error.message}`);
    next(error);
  }
};

module.exports.invoiceDetailView = invoiceDetailView;
