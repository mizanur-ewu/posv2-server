const { PrismaClient, Prisma } = require("@prisma/client");
const apiError = require("../utils/apiError");
const { logger } = require("../utils/logger");

const basePrisma = new PrismaClient({
  log: ["warn", "error"], // শুধু সমস্যা হলে log করবে
});

/** Date only columns – returned as "YYYY-MM-DD" (every other date is an ISO string). */
const DATE_ONLY = new Set(["date", "expiryDate", "startDate", "endDate", "trialEndsAt", "paidUntil", "periodFrom", "periodTo", "warrantyUntil", "receivedDate", "deliveredDate"]);

/**
 * Prisma returns Decimal objects and Date objects. The API and the stock engine work with
 * plain numbers (rounded with r2 / r3) and date strings, exactly like the frontend expects.
 */
const toPlain = (value, key) => {
  if (value === null || value === undefined) return value;
  if (value instanceof Date) {
    return DATE_ONLY.has(key) ? value.toISOString().slice(0, 10) : value.toISOString();
  }
  if (Prisma.Decimal.isDecimal(value)) return value.toNumber();
  if (Array.isArray(value)) return value.map((v) => toPlain(v, key));
  if (typeof value === "object") {
    const out = {};
    Object.keys(value).forEach((k) => {
      out[k] = toPlain(value[k], k);
    });
    return out;
  }
  return value;
};

const prisma = basePrisma.$extends({
  name: "plainValues",
  query: {
    $allModels: {
      async $allOperations({ args, query }) {
        return toPlain(await query(args));
      },
    },
  },
});

const connectDB = async () => {
  try {
    await prisma.$connect();
    logger.info("✅ Database connection established successfully");
  } catch (error) {
    logger.error("❌ Database connection failed", error);
    throw new apiError(500, "Database connection failed");
  }
};

module.exports = { connectDB, prisma, basePrisma };
