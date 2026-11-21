const jwt = require("jsonwebtoken");
const { prisma } = require("../config/db");
const { logger } = require("../utils/logger");

/**
 * Checks the Bearer token of a platform person (owner / support) and attaches req.platformUser.
 * Shop tokens are refused.
 */
const authenticatePlatform = async (req, res, next) => {
  const authHeader = req.headers.authorization;
  if (!authHeader || !authHeader.startsWith("Bearer ")) {
    return res.status(401).json({ status: "error", message: "Unauthorized: No token" });
  }
  try {
    const decoded = jwt.verify(authHeader.split(" ")[1], process.env.JWT_SECRET);
    if (decoded.kind !== "platform") return res.status(403).json({ status: "error", message: "Access denied" });
    const pu = await prisma.platformUser.findUnique({
      where: { id: decoded.id },
      select: { id: true, name: true, email: true, phone: true, role: true, status: true, lastLoginAt: true, createdAt: true },
    });
    if (!pu || pu.status !== "active") {
      return res.status(401).json({ status: "error", message: "Session expired, please sign in again" });
    }
    req.platformUser = pu;
    next();
  } catch (err) {
    logger.warn(`Invalid platform token: ${err.message}`);
    return res.status(401).json({ status: "error", message: "Session expired, please sign in again" });
  }
};

/** Only the platform owner role may continue (prices, settings, team, deleting shops). */
const requireOwner = (req, res, next) => {
  if (req.platformUser?.role !== "owner") {
    return res.status(403).json({ status: "error", message: "Only a platform owner can do this" });
  }
  next();
};

module.exports = { authenticatePlatform, requireOwner };
