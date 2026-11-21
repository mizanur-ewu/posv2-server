function apiError(statusCode, message, isOperational = true, stack = "") {
  const error = new Error(message);
  error.statusCode = statusCode;
  error.isOperational = isOperational;

  if (stack) {
    error.stack = stack;
  } else {
    Error.captureStackTrace(error, apiError);
  }

  return error;
}

// Common shortcuts for HTTP errors
apiError.badRequest = (message) => apiError(400, message);
apiError.unauthorized = (message) => apiError(401, message);
apiError.forbidden = (message) => apiError(403, message);
apiError.notFound = (message) => apiError(404, message);
apiError.conflict = (message) => apiError(409, message);
apiError.internal = (message) => apiError(500, message);

module.exports = apiError;
