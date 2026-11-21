const winston = require("winston");
const DailyRotateFile = require("winston-daily-rotate-file");

const logger = winston.createLogger({
  level: process.env.LOG_LEVEL || "info",
  format: winston.format.combine(
    winston.format.timestamp(),
    winston.format.json(), // JSON output
  ),
  transports: [
    new winston.transports.Console(),
    new DailyRotateFile({
      filename: "logs/app-%DATE%.log", // The log file name will include the date (e.g., app-2025-05-06.log)
      datePattern: "YYYY-MM-DD", // Set the date format for the file name
      maxSize: "20m", // Max file size before rotating (20MB)
      maxFiles: "14d", // Keep logs for 14 days
      zippedArchive: true, // Compress rotated log files to save space
    }),
  ],
});

// Morgan stream for HTTP request logging
const morganStream = {
  write: (message) => {
    logger.info(message.trim());
  },
};

module.exports = { logger, morganStream };
