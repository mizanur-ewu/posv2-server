const jwt = require("jsonwebtoken");
const { prisma } = require("../config/db");
const { logger } = require("../utils/logger");
const { getPlatformSettings, billingOf } = require("../utils/platform");

/** Requests a read-only (expired) shop can still make besides reading. */
const ALWAYS_ALLOWED = ["/api/v1/auth/logout", "/api/v1/auth/changePassword"];

/**
 * Checks the Bearer token of a shop user, loads the user with role and store, and attaches:
 *   req.user       – the signed-in user (without password) + role
 *   req.storeId / req.companyId / req.storeCode / req.subscription – the tenant every query is scoped by
 *   req.employee   – the SR / delivery man record linked to this user (or null)
 *   req.billing    – where the shop's subscription stands (see utils/platform billingOf)
 *   req.impersonator – { id, name } when a platform person opened this shop
 * A suspended shop is signed out. An expired shop (past its grace days) can only read.
 */
const authenticateJWT = async (req, res, next) => {
  const authHeader = req.headers.authorization;
  if (!authHeader || !authHeader.startsWith("Bearer ")) {
    return res.status(401).json({ status: "error", message: "Unauthorized: No token" });
  }

  try {
    const decoded = jwt.verify(authHeader.split(" ")[1], process.env.JWT_SECRET);
    if (decoded.kind === "platform") {
      return res.status(403).json({ status: "error", message: "Open a shop from the admin console to work in it." });
    }

    const user = await prisma.user.findUnique({
      where: { id: decoded?.id },
      select: {
        id: true,
        name: true,
        email: true,
        phone: true,
        loginWith: true,
        status: true,
        roleId: true,
        storeId: true,
        companyId: true,
        role: { select: { id: true, key: true, name: true, system: true, permissions: true } },
        store: { select: { id: true, code: true, name: true, subscription: true, status: true, suspendReason: true, trialEndsAt: true, paidUntil: true } },
      },
    });

    if (!user || user.storeId !== decoded.storeId) {
      logger.warn(`User not found for token`);
      return res.status(401).json({ status: "error", message: "Session expired, please sign in again" });
    }
    const impersonator = decoded.imp ? { id: decoded.imp, name: decoded.impName || "Platform" } : null;

    if (user.status !== "active" && !impersonator) {
      return res.status(401).json({ status: "error", message: "This user is inactive. Ask your admin to activate it." });
    }

    const settings = await getPlatformSettings();
    const billing = billingOf(user.store, settings);
    if (billing.state === "suspended" && !impersonator) {
      return res.status(401).json({ status: "error", message: "This shop is suspended. Contact support to open it again." });
    }

    const employee = await prisma.employee.findFirst({
      where: { storeId: user.storeId, userId: user.id },
      select: { id: true, type: true, srMode: true, status: true, name: true },
    });
    if (employee && employee.status !== "active" && !impersonator) {
      return res.status(401).json({ status: "error", message: "This SR is inactive. Ask your manager to activate the SR." });
    }

    if (billing.readOnly && !impersonator && req.method !== "GET" && !ALWAYS_ALLOWED.includes(req.originalUrl.split("?")[0])) {
      return res.status(402).json({
        status: "error",
        message: "Your subscription has ended, so the shop is read-only. You can still see and download everything. Renew to add or change data.",
      });
    }

    req.user = user;
    req.role = user.role;
    req.employee = employee;
    req.storeId = user.storeId;
    req.companyId = user.companyId;
    req.storeCode = user.store.code;
    req.subscription = user.store.subscription;
    req.billing = billing;
    req.impersonator = impersonator;
    next();
  } catch (err) {
    logger.warn(`Invalid token: ${err.message}`);
    return res.status(401).json({ status: "error", message: "Session expired, please sign in again" });
  }
};

module.exports = authenticateJWT;
