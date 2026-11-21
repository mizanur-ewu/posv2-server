const { logger } = require("../../utils/logger");

/**
 * BulkSMSBD gateway (http://bulksmsbd.net). Settings in .env:
 *   SMS_API_KEY   (or API_KEY)    – the account's API key
 *   SMS_SENDER_ID (or SENDER_ID)  – approved sender id / masking name
 *   SMS_API_URL                    – optional, default http://bulksmsbd.net/api/smsapi
 * Only this file knows the gateway; to change provider, replace `send` and keep its contract:
 *   send(number, message) → { ok: true, ref } | { ok: false, error, retry }
 */
const config = () => ({
  apiKey: process.env.SMS_API_KEY || process.env.API_KEY || "",
  senderId: process.env.SMS_SENDER_ID || process.env.SENDER_ID || "",
  url: process.env.SMS_API_URL || "http://bulksmsbd.net/api/smsapi",
});

const isConfigured = () => {
  const c = config();
  return !!(c.apiKey && c.senderId);
};

/** BulkSMSBD answers response_code 202 when the message is accepted; anything else is an error. */
const send = async (number, message) => {
  const c = config();
  if (!c.apiKey || !c.senderId) return { ok: false, error: "SMS gateway is not set up (SMS_API_KEY / SMS_SENDER_ID)", retry: false };

  let response;
  try {
    response = await fetch(c.url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ api_key: c.apiKey, senderid: c.senderId, number, message }),
      signal: AbortSignal.timeout(15000),
    });
  } catch (e) {
    logger.warn(`SMS gateway not reachable: ${e.message}`);
    return { ok: false, error: `Gateway not reachable: ${e.message}`, retry: true };
  }

  const text = await response.text();
  let data = null;
  try {
    data = JSON.parse(text);
  } catch {
    /* not JSON */
  }
  if (!response.ok) {
    logger.warn(`SMS gateway HTTP ${response.status}: ${text.slice(0, 200)}`);
    return { ok: false, error: `Gateway HTTP ${response.status}`, retry: response.status >= 500 };
  }
  const code = data?.response_code ?? data?.code;
  if (code !== undefined && String(code) !== "202") {
    const error = data?.error_message || data?.message || `Gateway code ${code}`;
    logger.warn(`SMS rejected (${code}): ${error}`);
    return { ok: false, error: `${error} (${code})`, retry: false };
  }
  return { ok: true, ref: String(data?.message_id ?? data?.success_message ?? "accepted").slice(0, 120) };
};

module.exports = { send, isConfigured, config };
