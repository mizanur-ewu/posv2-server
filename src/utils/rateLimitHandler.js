// utils/rateLimitHandler.js

/**
 * Custom handler for express-rate-limit
 * Sends a 429 response with remaining time until rate limit resets.
 */
function rateLimitHandler(req, res, next, options) {
  let resetTime = req.rateLimit?.resetTime;
  let remainingSeconds;

  if (resetTime instanceof Date && !isNaN(resetTime)) {
    remainingSeconds = Math.max(0, Math.ceil((resetTime - Date.now()) / 1000));
  } else {
    // Fallback: read from standard headers (RateLimit-Reset is Unix timestamp in seconds)
    const resetHeader = res.getHeader("RateLimit-Reset");
    if (resetHeader) {
      const resetTimestampSeconds = parseInt(resetHeader, 10);
      if (!isNaN(resetTimestampSeconds)) {
        remainingSeconds = Math.max(
          0,
          resetTimestampSeconds - Math.floor(Date.now() / 1000),
        );
      }
    }
  }

  // Final fallback: use windowMs from options (if provided)
  if (remainingSeconds === undefined || remainingSeconds <= 0) {
    const windowMs = options.windowMs || 15 * 60 * 1000;
    remainingSeconds = Math.ceil(windowMs / 1000);
  }

  const minutes = Math.floor(remainingSeconds / 60);
  const seconds = remainingSeconds % 60;

  let timeMessage = "";
  if (minutes > 0 && seconds > 0) {
    timeMessage = `${minutes} minute${minutes !== 1 ? "s" : ""} and ${seconds} second${seconds !== 1 ? "s" : ""}`;
  } else if (minutes > 0) {
    timeMessage = `${minutes} minute${minutes !== 1 ? "s" : ""}`;
  } else {
    timeMessage = `${seconds} second${seconds !== 1 ? "s" : ""}`;
  }

  res.status(options.statusCode || 429).json({
    status: "error",
    message: `Too many requests. Please try again in ${timeMessage}.`,
    retryAfter: remainingSeconds,
  });
}

module.exports = rateLimitHandler;
