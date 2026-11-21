const { logger } = require("../utils/logger");
const { prisma } = require("../config/db");
const apiError = require("../utils/apiError");
const { r2, tenant, indexBy } = require("../utils/helperFunction");

const CUSTOMER_TYPES = ["walk_in", "regular", "retailer"];

/** Customers / retailers with sales, due and last sale. ?type=retailer|regular|walk_in */
exports.getAllCustomers = async (req, res, next) => {
  try {
    const where = { storeId: req.storeId };
    if (req.query.type) where.customerType = req.query.type;
    const [customers, sums, areas, routes, employees] = await Promise.all([
      prisma.customer.findMany({ where, orderBy: { createdAt: "asc" } }),
      prisma.salesInvoice.groupBy({
        by: ["soldToId"],
        where: { storeId: req.storeId, soldToId: { not: null } },
        _sum: { totalAmount: true, returnedAmount: true, totalDue: true },
        _max: { soldDate: true },
      }),
      prisma.area.findMany({ where: { storeId: req.storeId }, select: { id: true, name: true } }),
      prisma.route.findMany({ where: { storeId: req.storeId }, select: { id: true, name: true } }),
      prisma.employee.findMany({ where: { storeId: req.storeId }, select: { id: true, name: true } }),
    ]);
    const A = indexBy(areas);
    const R = indexBy(routes);
    const E = indexBy(employees);
    const data = customers.map((c) => {
      const s = sums.find((x) => x.soldToId === c.id);
      return {
        ...c,
        area: A.get(c.areaId)?.name,
        route: R.get(c.routeId)?.name,
        sr: c.srId ? E.get(c.srId)?.name || "—" : null,
        totalSales: r2((s?._sum.totalAmount || 0) - (s?._sum.returnedAmount || 0)),
        totalDue: r2(s?._sum.totalDue || 0),
        lastSale: s?._max.soldDate || null,
      };
    });
    return res.status(200).json({ status: "success", results: data.length, data });
  } catch (error) {
    logger.error(`Customers retrieval error: ${error.message}`);
    next(error);
  }
};

const customerFields = async (req, existing) => {
  const b = { ...(existing || {}), ...req.body };
  const where = { storeId: req.storeId };
  const clean = {
    customerType: b.customerType || "regular",
    name: String(b.name || "").trim(),
    ownerName: b.ownerName || null,
    phone: b.phone ? String(b.phone).trim() : null,
    address: b.address || null,
    areaId: b.areaId || null,
    routeId: b.routeId || null,
    latitude: b.latitude === "" || b.latitude == null ? null : Number(b.latitude),
    longitude: b.longitude === "" || b.longitude == null ? null : Number(b.longitude),
    srId: b.srId || null,
    status: b.status === "inactive" ? "inactive" : "active",
  };
  if (!clean.name) throw apiError.badRequest("Name is required");
  if (!CUSTOMER_TYPES.includes(clean.customerType)) throw apiError.badRequest("Select the customer type");
  if (clean.areaId && !(await prisma.area.findFirst({ where: { ...where, id: clean.areaId } }))) throw apiError.badRequest("Area not found");
  if (clean.routeId && !(await prisma.route.findFirst({ where: { ...where, id: clean.routeId } }))) throw apiError.badRequest("Route not found");
  if (clean.srId && !(await prisma.employee.findFirst({ where: { ...where, id: clean.srId } }))) throw apiError.badRequest("SR not found");
  return clean;
};

exports.createCustomer = async (req, res, next) => {
  try {
    const clean = await customerFields(req);
    const customer = await prisma.customer.create({ data: { ...tenant(req), ...clean } });
    return res.status(201).json({ status: "success", message: "Customer saved", data: customer });
  } catch (error) {
    logger.error(`Customer creation error: ${error.message}`);
    next(error);
  }
};

exports.updateCustomer = async (req, res, next) => {
  try {
    const existing = await prisma.customer.findFirst({ where: { id: req.params.id, storeId: req.storeId } });
    if (!existing) throw apiError.notFound("Customer not found");
    const { id, storeId, companyId, createdAt, updatedAt, ...rest } = existing;
    const clean = await customerFields(req, rest);
    const customer = await prisma.customer.update({ where: { id: existing.id }, data: clean });
    return res.status(200).json({ status: "success", message: "Customer saved", data: customer });
  } catch (error) {
    logger.error(`Customer update error: ${error.message}`);
    next(error);
  }
};

/* ---------------- areas & routes ---------------- */
exports.createArea = async (req, res, next) => {
  try {
    const name = String(req.body.name || "").trim();
    if (!name) throw apiError.badRequest("Area name is required");
    const area = await prisma.area.create({ data: { ...tenant(req), name } });
    return res.status(201).json({ status: "success", message: "Area saved", data: area });
  } catch (error) {
    logger.error(`Area creation error: ${error.message}`);
    next(error);
  }
};

exports.updateArea = async (req, res, next) => {
  try {
    const name = String(req.body.name || "").trim();
    if (!name) throw apiError.badRequest("Area name is required");
    if (!(await prisma.area.findFirst({ where: { id: req.params.id, storeId: req.storeId } }))) throw apiError.notFound("Area not found");
    const area = await prisma.area.update({ where: { id: req.params.id }, data: { name } });
    return res.status(200).json({ status: "success", message: "Area saved", data: area });
  } catch (error) {
    logger.error(`Area update error: ${error.message}`);
    next(error);
  }
};

const routeFields = async (req) => {
  const where = { storeId: req.storeId };
  const clean = { name: String(req.body.name || "").trim(), areaId: req.body.areaId || null, srId: req.body.srId || null };
  if (!clean.name) throw apiError.badRequest("Route name is required");
  if (clean.areaId && !(await prisma.area.findFirst({ where: { ...where, id: clean.areaId } }))) throw apiError.badRequest("Area not found");
  if (clean.srId && !(await prisma.employee.findFirst({ where: { ...where, id: clean.srId } }))) throw apiError.badRequest("SR not found");
  return clean;
};

exports.createRoute = async (req, res, next) => {
  try {
    const route = await prisma.route.create({ data: { ...tenant(req), ...(await routeFields(req)) } });
    return res.status(201).json({ status: "success", message: "Route saved", data: route });
  } catch (error) {
    logger.error(`Route creation error: ${error.message}`);
    next(error);
  }
};

exports.updateRoute = async (req, res, next) => {
  try {
    if (!(await prisma.route.findFirst({ where: { id: req.params.id, storeId: req.storeId } }))) throw apiError.notFound("Route not found");
    const route = await prisma.route.update({ where: { id: req.params.id }, data: await routeFields(req) });
    return res.status(200).json({ status: "success", message: "Route saved", data: route });
  } catch (error) {
    logger.error(`Route update error: ${error.message}`);
    next(error);
  }
};
