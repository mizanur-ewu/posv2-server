const { Prisma } = require("@prisma/client");
const { logger } = require("../utils/logger");

const globalErrorHandler = (err, req, res, next) => {
  err.statusCode = err.statusCode || 500;
  err.status = err.status || "error";

  // 🛠 Prisma errors the user can fix
  if (err instanceof Prisma.PrismaClientKnownRequestError) {
    if (err.code === "P2002") {
      const fields = [].concat(err.meta?.target || []).join(", ");
      err.statusCode = 409;
      err.message = `Duplicate value for ${fields || "a unique field"}`;
    }
    if (err.code === "P2003") {
      err.statusCode = 400;
      err.message = "This record is still used somewhere else";
    }
    if (err.code === "P2025") {
      err.statusCode = 404;
      err.message = "Requested record not found.";
    }
  }
  if (err instanceof Prisma.PrismaClientValidationError) {
    err.statusCode = 400;
    err.message = "Validation error: Invalid input data.";
  }
  // JSON body that can't be parsed
  if (err.type === "entity.parse.failed") {
    err.statusCode = 400;
    err.message = "Invalid JSON body";
  }

  logger.error(`❌ ${err.statusCode} ${err.message}`);

  if (process.env.NODE_ENV === "development" && err.statusCode >= 500) {
    res.status(err.statusCode).json({
      status: err.status,
      message: err.message,
      error: err,
      stack: err.stack,
    });
  } else {
    res.status(err.statusCode).json({
      status: err.status,
      message: err.message,
    });
  }
};

module.exports = globalErrorHandler;
