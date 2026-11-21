const dayjs = require("dayjs");
const { logger } = require("../utils/logger");
const { prisma } = require("../config/db");
const apiError = require("../utils/apiError");
const { ctxOf, listParam } = require("../utils/helperFunction");
const { roleCan } = require("../utils/permissions");
const { storeTransaction } = require("../utils/storeTransaction");
const { stockTransaction } = require("../utils/stock/stockWork");
const { createOrder, cancelOrder, updateOrder, deleteOrder, deliverOrder } = require("../utils/stock/dealer");
const { loadLookups, orderViews, withRoutes, ORDER_INCLUDE } = require("../utils/viewHelper");

const can = (req, page, action) => roleCan(req.role, req.subscription, page, action);

/** An SR who only has "My Sales Order" works with their own orders only. */
const ownSrOnly = (req, action = "view") => !can(req, "orders", action) && !(action === "view" && can(req, "issues", "view"));

const orderView = async (storeId, order) => {
  const L = await withRoutes(prisma, await loadLookups(prisma, storeId), storeId);
  return (await orderViews(prisma, L, [order]))[0];
};

/** Sales orders. Filters: status (one or a comma list), srId, routeId, date. */
exports.getAllOrders = async (req, res, next) => {
  try {
    const where = { storeId: req.storeId };
    const status = listParam(req.query.status);
    if (status) where.status = { in: status };
    let srId = req.query.srId || null;
    if (ownSrOnly(req)) srId = req.employee?.id || "none";
    if (srId) where.srId = srId;
    if (req.query.date) {
      where.orderDate = { gte: dayjs(req.query.date).startOf("day").toDate(), lte: dayjs(req.query.date).endOf("day").toDate() };
    }
    if (req.query.routeId) {
      const onRoute = await prisma.customer.findMany({ where: { storeId: req.storeId, routeId: req.query.routeId }, select: { id: true } });
      where.customerId = { in: onRoute.map((c) => c.id) };
    }

    const [L, orders] = await Promise.all([
      loadLookups(prisma, req.storeId),
      prisma.salesOrder.findMany({ where, include: ORDER_INCLUDE, orderBy: { orderDate: "desc" } }),
    ]);
    await withRoutes(prisma, L, req.storeId);
    const data = await orderViews(prisma, L, orders);
    return res.status(200).json({ status: "success", results: data.length, data });
  } catch (error) {
    logger.error(`Orders retrieval error: ${error.message}`);
    next(error);
  }
};

exports.createOrder = async (req, res, next) => {
  try {
    const body = { ...req.body };
    if (ownSrOnly(req, "create")) {
      if (!req.employee || req.employee.type !== "sr") throw apiError.forbidden("Only an SR can take orders here");
      body.srId = req.employee.id;
    }
    const order = await storeTransaction(req.storeId, (tx) => createOrder(tx, ctxOf(req), body));
    return res.status(201).json({ status: "success", message: `Order ${order.orderNo} saved`, data: await orderView(req.storeId, order) });
  } catch (error) {
    logger.error(`Order creation error: ${error.message}`);
    next(error);
  }
};

exports.updateOrder = async (req, res, next) => {
  try {
    const order = await storeTransaction(req.storeId, (tx) => updateOrder(tx, ctxOf(req), req.params.id, req.body));
    return res.status(200).json({ status: "success", message: `Order ${order.orderNo} updated`, data: await orderView(req.storeId, order) });
  } catch (error) {
    logger.error(`Order update error: ${error.message}`);
    next(error);
  }
};

exports.cancelOrder = async (req, res, next) => {
  try {
    if (ownSrOnly(req, "cancel")) {
      const o = await prisma.salesOrder.findFirst({ where: { id: req.params.id, storeId: req.storeId }, select: { srId: true } });
      if (!o || o.srId !== req.employee?.id) throw apiError.forbidden("You can cancel your own orders only");
    }
    const order = await storeTransaction(req.storeId, (tx) => cancelOrder(tx, ctxOf(req), req.params.id));
    return res.status(200).json({ status: "success", message: `Order ${order.orderNo} cancelled`, data: order });
  } catch (error) {
    logger.error(`Order cancel error: ${error.message}`);
    next(error);
  }
};

exports.deleteOrder = async (req, res, next) => {
  try {
    const result = await storeTransaction(req.storeId, (tx) => deleteOrder(tx, ctxOf(req), req.params.id));
    return res.status(200).json({ status: "success", message: `Order ${result.orderNo} deleted`, data: result });
  } catch (error) {
    logger.error(`Order delete error: ${error.message}`);
    next(error);
  }
};

/** Delivery man (app) delivers an issued order: the invoice is made at once. */
exports.deliverOrder = async (req, res, next) => {
  try {
    if (req.employee?.type === "delivery_man") {
      const o = await prisma.salesOrder.findFirst({ where: { id: req.params.id, storeId: req.storeId }, select: { deliveryManId: true } });
      if (!o || o.deliveryManId !== req.employee.id) throw apiError.forbidden("This order is not assigned to you");
    }
    const { lines, collected, paymentMethodId, date } = req.body;
    const invoice = await stockTransaction(ctxOf(req), (work) =>
      deliverOrder(work, req.params.id, { lines: Array.isArray(lines) ? lines : [], collected, paymentMethodId, date, viaApp: true }),
    );
    return res.status(200).json({ status: "success", message: invoice ? `Invoice ${invoice.invoiceNo} saved` : "Saved", data: invoice });
  } catch (error) {
    logger.error(`Order delivery error: ${error.message}`);
    next(error);
  }
};
