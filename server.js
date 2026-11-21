require("dotenv").config();
// Business time zone first: "today", date-only fields and day-wise reports follow it
process.env.TZ = process.env.TZ || "Asia/Dhaka";
require("./src/cron/cronJobs"); // initialize all cron jobs

const express = require("express");
const cors = require("cors");
const helmet = require("helmet");
const rateLimit = require("express-rate-limit");
const { logger } = require("./src/utils/logger");
const apiError = require("./src/utils/apiError");
const { connectDB, prisma } = require("./src/config/db");
const globalErrorHandler = require("./src/middlewares/globalErrorHandler");
const rateLimitHandler = require("./src/utils/rateLimitHandler");

const authRoutes = require("./src/routes/auth.routes");
const settingsRoutes = require("./src/routes/settings.routes");
const productRoutes = require("./src/routes/product.routes");
const supplierRoutes = require("./src/routes/supplier.routes");
const stockRoutes = require("./src/routes/stock.routes");
const adjustmentRoutes = require("./src/routes/adjustment.routes");
const discountRoutes = require("./src/routes/discount.routes");
const expenseRoutes = require("./src/routes/expense.routes");
const invoiceRoutes = require("./src/routes/invoice.routes");
const salesReturnRoutes = require("./src/routes/salesReturn.routes");
const dueRoutes = require("./src/routes/due.routes");
const customerRoutes = require("./src/routes/customer.routes");
const employeeRoutes = require("./src/routes/employee.routes");
const salesOrderRoutes = require("./src/routes/salesOrder.routes");
const productIssueRoutes = require("./src/routes/productIssue.routes");
const dashboardRoutes = require("./src/routes/dashboard.routes");
const reportRoutes = require("./src/routes/report.routes");
const platformRoutes = require("./src/routes/platform.routes");
const cashRoutes = require("./src/routes/cash.routes");
const warrantyRoutes = require("./src/routes/warranty.routes");

const app = express();

// ======================
// Security Middlewares
// ======================

// 1. Helmet - সিকিউরিটি হেডার
app.use(
  helmet({
    contentSecurityPolicy: {
      directives: {
        defaultSrc: ["'self'"],
        scriptSrc: ["'self'"],
        styleSrc: ["'self'", "'unsafe-inline'"],
        imgSrc: ["'self'", "data:"],
      },
    },
    hsts: {
      maxAge: 31536000, // 1 বছর
      includeSubDomains: true,
      preload: true,
    },
    frameguard: { action: "deny" }, // Clickjacking protection
  }),
);

// 2. CORS – ALLOWED_ORIGINS=https://a.com,https://b.com (empty = allow all, for development)
const allowedOrigins = (process.env.ALLOWED_ORIGINS || "")
  .split(",")
  .map((o) => o.trim())
  .filter(Boolean);
app.use(cors(allowedOrigins.length ? { origin: allowedOrigins } : undefined));

// 3. Body Parser with Limit (stock entries / sales returns can carry many lines)
app.use(express.json({ limit: "1mb" }));
app.use(express.urlencoded({ extended: true, limit: "1mb" }));

// 4. Rate Limiter (Brute force + Abuse Protection)
const generalLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutes
  max: 3000, // a POS screen refreshes many lists – keep this generous
  standardHeaders: true,
  legacyHeaders: false,
  handler: rateLimitHandler,
});

// Auth routes এর জন্য কঠিন লিমিট (Brute force আটকাতে)
const authLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 50, // লগইন এ খুব কম
  handler: rateLimitHandler,
});

app.use("/api/v1/", generalLimiter); // সব API রুটে
app.use("/api/v1/auth/login", authLimiter); // লগইন রুটে কঠিন লিমিট
app.use("/api/v1/auth/signup", authLimiter); // new shops: same strict limit
app.use("/api/v1/auth/forgot", authLimiter); // SMS codes
app.use("/api/v1/auth/reset", authLimiter);

// Logger middleware (passwords are never written to the log)
app.use((req, res, next) => {
  const { password, currentPassword, newPassword, code, ...body } = req.body || {};
  logger.info(`${req.method} ${req.originalUrl}`, {
    body,
    query: req.query,
  });
  next();
});

app.get("/", (req, res) => {
  res.status(200).json({
    status: "success",
    message: "Welcome to the POS & Dealer API",
    port: process.env.PORT || 4000,
  });
});

// API routes
app.use("/api/v1/auth", authRoutes);
app.use("/api/v1/settings", settingsRoutes);
app.use("/api/v1/product", productRoutes);
app.use("/api/v1/supplier", supplierRoutes);
app.use("/api/v1/stock", stockRoutes);
app.use("/api/v1/adjustment", adjustmentRoutes);
app.use("/api/v1/discount", discountRoutes);
app.use("/api/v1/expense", expenseRoutes);
app.use("/api/v1/invoice", invoiceRoutes);
app.use("/api/v1/salesReturn", salesReturnRoutes);
app.use("/api/v1/due", dueRoutes);
app.use("/api/v1/customer", customerRoutes);
app.use("/api/v1/employee", employeeRoutes);
app.use("/api/v1/salesOrder", salesOrderRoutes);
app.use("/api/v1/productIssue", productIssueRoutes);
app.use("/api/v1/dashboard", dashboardRoutes);
app.use("/api/v1/report", reportRoutes);
app.use("/api/v1/platform", platformRoutes);
app.use("/api/v1/cash", cashRoutes);
app.use("/api/v1/warranty", warrantyRoutes);

// Health check endpoint
app.get("/healthcheck", (req, res) => {
  res.status(200).json({
    status: "ok",
    message: "Server is running",
    timestamp: new Date().toISOString(),
  });
});

// Handle 404 routes
app.all("*", (req, res, next) => {
  next(apiError(404, `Can't find ${req.originalUrl} on this server!`));
});

// Global error handler
app.use(globalErrorHandler);

// ======================
// Server Setup + Graceful Shutdown
// ======================
const PORT = process.env.PORT || 4000;

let server;

const startServer = async () => {
  try {
    // 1. DB আগে connect হবে — DB fail করলে server listen-ই করবে না
    await connectDB();

    // 2. তারপর server listen
    server = app.listen(PORT, () => {
      logger.info(`🚀 Server running on port ${PORT}`);

      // PM2-কে জানানো যে app ready (wait_ready ব্যবহার করলে)
      if (process.send) {
        process.send("ready");
      }
    });
  } catch (error) {
    logger.error("💥 Failed to start server:", error.message);
    process.exit(1);
  }
};

let shuttingDown = false;

const shutdown = async (signal) => {
  if (shuttingDown) return; // দুইবার signal আসলে ignore
  shuttingDown = true;

  logger.info(`⚠️ ${signal} received, shutting down gracefully...`);

  // Safety net: cleanup আটকে গেলে 10 সেকেন্ড পর force exit
  const forceExitTimer = setTimeout(() => {
    logger.error("💥 Forced shutdown after 10s timeout");
    process.exit(1);
  }, 10000);
  forceExitTimer.unref();

  // Server এখনো start না হলে শুধু Prisma disconnect করে exit
  if (!server) {
    await prisma.$disconnect().catch(() => {});
    process.exit(0);
  }

  // 1. নতুন connection নেওয়া বন্ধ, চলমান request গুলো শেষ হওয়া পর্যন্ত wait
  server.close(async (err) => {
    if (err) {
      logger.error("Error closing HTTP server:", err);
    }

    // 2. তারপর Prisma disconnect (pg connection pool বন্ধ হবে)
    try {
      await prisma.$disconnect();
      logger.info("✅ Prisma disconnected, shutdown complete");
      process.exit(err ? 1 : 0);
    } catch (e) {
      logger.error("Error disconnecting Prisma:", e);
      process.exit(1);
    }
  });
};

process.on("SIGINT", () => shutdown("SIGINT")); // PM2 stop/reload
process.on("SIGTERM", () => shutdown("SIGTERM")); // kill / systemd

// Crash হলেও যেন DB connection পরিষ্কারভাবে বন্ধ হয়
process.on("uncaughtException", (err) => {
  logger.error("💥 Uncaught Exception:", err);
  shutdown("uncaughtException");
});

process.on("unhandledRejection", (reason) => {
  logger.error("💥 Unhandled Rejection:", reason);
  shutdown("unhandledRejection");
});

// Test এর সময় server চালু হবে না, শুধু app export হবে
if (require.main === module) {
  logger.info("🟢 Running as MAIN entry — starting server (server mode)");
  startServer();
} else {
  logger.info("🟡 Imported as MODULE — server NOT started (test mode)");
}

module.exports = app; // For testing purposes
