const dayjs = require("dayjs");
const { prisma } = require("../../config/db");
const { logger } = require("../../utils/logger");
const { r2 } = require("../../utils/helperFunction");
const provider = require("./provider");

/**
 * SMS for the platform and its shops.
 *
 *   queueSms()        – validate, count parts, check credits, save as "queued" (never sends inline,
 *                        so a sale never waits for the gateway)
 *   processQueue()    – the worker (every few seconds): sends, retries 3 times, charges credits
 *   shopEvent()       – a shop event (sale, payment …) → the shop's template → queue, if the shop turned it on
 *
 * Test mode (PlatformSetting.smsLive = false): messages are logged with status "test" and nothing is sent.
 * Shop messages cost the shop 1 credit per SMS part (charged only when sent); platform messages
 * (OTP, subscription reminders, tests) are free for the shop.
 */

const FREE_TYPES = new Set(["otp", "subscription", "test"]);

/* ---------------- numbers and length ---------------- */
/** Any Bangladeshi mobile form → 8801XXXXXXXXX, or null. */
const bdNumber = (phone) => {
  let d = String(phone || "").replace(/\D/g, "");
  if (d.startsWith("880")) d = d.slice(2);
  if (d.length === 10 && d.startsWith("1")) d = `0${d}`;
  return /^01[3-9]\d{8}$/.test(d) ? `88${d}` : null;
};

/** Plain English text fits 160 characters per SMS (153 when split); Bangla / unicode fits 70 (67). */
const smsParts = (message) => {
  const text = String(message || "");
  const unicode = /[^\x00-\x7F]/.test(text);
  const [one, many] = unicode ? [70, 67] : [160, 153];
  return { unicode, length: text.length, parts: text.length <= one ? 1 : Math.ceil(text.length / many) };
};

/* ---------------- templates ---------------- */
const TEMPLATES = {
  en: {
    sale: "Thank you for shopping at {shop}. Invoice {invoice}: Tk {amount}. Paid Tk {paid}, due Tk {due}.",
    payment: "{shop}: received Tk {amount} from {customer}. Your due now: Tk {due}. Thank you.",
    due_reminder: "Dear {customer}, your due at {shop} is Tk {due}. Please pay at your convenience. Thank you.",
    daily_summary: "{shop} {date}: sales Tk {sales} ({invoices} invoices), cash in Tk {cash}, expenses Tk {expense}, new due Tk {due}.",
  },
  bn: {
    sale: "{shop}-এ কেনাকাটার জন্য ধন্যবাদ। ইনভয়েস {invoice}: {amount} টাকা। জমা {paid}, বাকি {due} টাকা।",
    payment: "{shop}: {customer} থেকে {amount} টাকা পাওয়া গেছে। এখন বাকি {due} টাকা। ধন্যবাদ।",
    due_reminder: "প্রিয় {customer}, {shop}-এ আপনার বাকি {due} টাকা। সুবিধামতো পরিশোধ করুন। ধন্যবাদ।",
    daily_summary: "{shop} {date}: বিক্রি {sales} টাকা ({invoices} ইনভয়েস), নগদ জমা {cash}, খরচ {expense}, নতুন বাকি {due} টাকা।",
  },
};
const EVENT_KEYS = ["sale", "payment", "due_reminder", "daily_summary"];

/** A shop's SMS settings with defaults filled in. */
const shopSmsSettings = (store) => {
  const s = store?.smsSettings && typeof store.smsSettings === "object" ? store.smsSettings : {};
  const language = s.language === "bn" ? "bn" : "en";
  return {
    language,
    events: { sale: false, payment: false, daily_summary: false, ...(s.events || {}), due_reminder: true },
    templates: Object.fromEntries(EVENT_KEYS.map((k) => [k, (s.templates && s.templates[k]) || TEMPLATES[language][k]])),
    customTemplates: s.templates || {},
    ownerPhone: s.ownerPhone || "",
  };
};

const fill = (template, vars) => String(template || "").replace(/\{(\w+)\}/g, (m, k) => (vars[k] !== undefined && vars[k] !== null ? String(vars[k]) : m));
const tk = (n) => r2(n).toLocaleString("en-IN", { maximumFractionDigits: 2 });

/* ---------------- queue ---------------- */
/**
 * Save one SMS to send. Returns the log row. Never throws for business reasons: a bad number or
 * no credits gives a row with status "skipped" and the reason in `error`.
 */
const queueSms = async ({ storeId = null, to, message, type, createdById = null }) => {
  const number = bdNumber(to);
  const { parts } = smsParts(message);
  const base = { storeId, to: number || String(to || ""), message: String(message), type, parts, createdById };
  if (!number) return prisma.smsLog.create({ data: { ...base, status: "skipped", error: "Not a valid Bangladeshi mobile number" } });
  if (!String(message || "").trim()) return prisma.smsLog.create({ data: { ...base, status: "skipped", error: "Empty message" } });
  if (storeId && !FREE_TYPES.has(type)) {
    const store = await prisma.store.findUnique({ where: { id: storeId }, select: { smsBalance: true } });
    if (!store || store.smsBalance < parts) return prisma.smsLog.create({ data: { ...base, status: "skipped", error: "No SMS balance" } });
  }
  return prisma.smsLog.create({ data: { ...base, status: "queued" } });
};

/** A shop event → the shop's template → queued, if the shop turned that event on. Never throws. */
const shopEvent = async (storeId, event, to, vars) => {
  try {
    const store = await prisma.store.findUnique({ where: { id: storeId }, select: { id: true, name: true, smsSettings: true, status: true } });
    if (!store || store.status !== "active") return null;
    const s = shopSmsSettings(store);
    if (!s.events[event]) return null;
    const money = Object.fromEntries(Object.entries(vars).map(([k, v]) => [k, typeof v === "number" ? tk(v) : v]));
    return await queueSms({ storeId, to, type: event, message: fill(s.templates[event], { shop: store.name, ...money }) });
  } catch (e) {
    logger.error(`SMS event ${event} failed: ${e.message}`);
    return null;
  }
};

/* ---------------- worker ---------------- */
let busy = false;

/** Password codes are never kept readable once the SMS has gone (logs, admin screens). */
const maskCode = (sms) => (sms.type === "otp" ? sms.message.replace(/\b\d{4,8}\b/g, "******") : sms.message);
/** After the last try of a password-code SMS, keep only the masked text. */
const forgetCode = (sms, data) => (sms.type === "otp" ? { ...data, message: maskCode(sms) } : data);

/** Send what is queued. Credits are taken before sending and given back if the gateway refuses. */
const processQueue = async () => {
  if (busy) return;
  busy = true;
  try {
    const queued = await prisma.smsLog.findMany({ where: { status: "queued" }, orderBy: { createdAt: "asc" }, take: 25 });
    if (!queued.length) return;
    const setting = await prisma.platformSetting.findUnique({ where: { id: "default" }, select: { smsLive: true } });
    for (const sms of queued) {
      // claim it, so a second server process never sends the same message
      const claimed = await prisma.smsLog.updateMany({ where: { id: sms.id, status: "queued" }, data: { status: "sending" } });
      if (!claimed.count) continue;
      if (!setting?.smsLive) {
        await prisma.smsLog.update({ where: { id: sms.id }, data: forgetCode(sms, { status: "test", sentAt: new Date(), providerRef: "TEST MODE" }) });
        logger.info(`SMS (test mode) to ${sms.to}: ${maskCode(sms)}`);
        continue;
      }
      const chargeable = sms.storeId && !FREE_TYPES.has(sms.type);
      if (chargeable && !sms.charged) {
        const taken = await prisma.store.updateMany({ where: { id: sms.storeId, smsBalance: { gte: sms.parts } }, data: { smsBalance: { decrement: sms.parts } } });
        if (!taken.count) {
          await prisma.smsLog.update({ where: { id: sms.id }, data: { status: "skipped", error: "No SMS balance" } });
          continue;
        }
      }
      const result = await provider.send(sms.to, sms.message);
      const attempts = sms.attempts + 1;
      if (result.ok) {
        await prisma.smsLog.update({ where: { id: sms.id }, data: forgetCode(sms, { status: "sent", sentAt: new Date(), attempts, charged: !!chargeable, providerRef: result.ref, error: null }) });
        continue;
      }
      if (chargeable) await prisma.store.update({ where: { id: sms.storeId }, data: { smsBalance: { increment: sms.parts } } });
      const giveUp = !result.retry || attempts >= 3;
      await prisma.smsLog.update({ where: { id: sms.id }, data: giveUp ? forgetCode(sms, { status: "failed", attempts, charged: false, error: result.error }) : { status: "queued", attempts, charged: false, error: result.error } });
    }
  } catch (e) {
    logger.error(`SMS worker error: ${e.message}`);
  } finally {
    busy = false;
  }
};

/** Starts the worker (called once from the cron file). */
let timer = null;
const startSmsWorker = () => {
  if (timer) return;
  // a message left "sending" by a crash goes back in the queue
  prisma.smsLog
    .updateMany({ where: { status: "sending", createdAt: { lt: dayjs().subtract(5, "minute").toDate() } }, data: { status: "queued" } })
    .catch((e) => logger.error(`SMS worker reset failed: ${e.message}`));
  timer = setInterval(processQueue, 8000);
  timer.unref();
};

/* ---------------- scheduled messages ---------------- */
/** 21:30 every day: today's numbers to each shop owner who asked for it. */
const sendDailySummaries = async () => {
  const stores = await prisma.store.findMany({ where: { status: "active" }, select: { id: true, name: true, smsSettings: true } });
  const start = dayjs().startOf("day").toDate();
  for (const store of stores) {
    const s = shopSmsSettings(store);
    if (!s.events.daily_summary || !s.ownerPhone) continue;
    const where = { storeId: store.id };
    const [inv, cash, exp] = await Promise.all([
      prisma.salesInvoice.aggregate({ where: { ...where, soldDate: { gte: start } }, _sum: { totalAmount: true, returnedAmount: true, totalDue: true }, _count: { _all: true } }),
      prisma.customerPayment.aggregate({ where: { ...where, createdAt: { gte: start } }, _sum: { amount: true } }),
      prisma.expense.aggregate({ where: { ...where, createdAt: { gte: start } }, _sum: { amount: true } }),
    ]);
    await shopEvent(store.id, "daily_summary", s.ownerPhone, {
      date: dayjs().format("DD MMM"),
      sales: Number(inv._sum.totalAmount || 0) - Number(inv._sum.returnedAmount || 0),
      invoices: inv._count._all,
      cash: Number(cash._sum.amount || 0),
      expense: Number(exp._sum.amount || 0),
      due: Number(inv._sum.totalDue || 0),
    });
  }
};

/**
 * 10:00 every day: tell shop owners their trial / subscription ends in 7, 3 or 1 days, today,
 * or has just become read-only. Free for the shop. Once per shop per day.
 */
const sendSubscriptionReminders = async () => {
  const { getPlatformSettings, billingOf } = require("../../utils/platform");
  const settings = await getPlatformSettings(true);
  if (!settings.smsReminders) return;
  const stores = await prisma.store.findMany({
    where: { status: "active", OR: [{ trialEndsAt: { not: null } }, { paidUntil: { not: null } }] },
    include: { users: { where: { status: "active", role: { system: true } }, orderBy: { createdAt: "asc" }, take: 1, select: { phone: true } } },
  });
  const contact = [settings.supportPhone].filter(Boolean).join("");
  const today = dayjs().startOf("day").toDate();
  for (const store of stores) {
    const b = billingOf(store, settings);
    let text = null;
    const what = b.state === "trial" ? "free trial" : "subscription";
    if (["trial", "active"].includes(b.state) && [7, 3, 1].includes(b.daysLeft)) text = `${settings.brandName}: your ${what} for ${store.name} ends in ${b.daysLeft} day(s) (${dayjs(b.endsAt).format("DD MMM")}).`;
    else if (["trial", "active"].includes(b.state) && b.daysLeft === 0) text = `${settings.brandName}: your ${what} for ${store.name} ends today.`;
    else if (b.state === "expired" && b.graceEndsAt === dayjs().subtract(1, "day").format("YYYY-MM-DD")) text = `${settings.brandName}: ${store.name} is now read-only. Renew to add sales again.`;
    if (!text) continue;
    if (contact) text += ` Call ${contact} to renew.`;
    const to = store.users[0]?.phone || store.phone;
    if (!to) continue;
    const sentToday = await prisma.smsLog.count({ where: { storeId: store.id, type: "subscription", createdAt: { gte: today } } });
    if (!sentToday) await queueSms({ storeId: store.id, to, type: "subscription", message: text });
  }
};

module.exports = {
  bdNumber,
  smsParts,
  TEMPLATES,
  EVENT_KEYS,
  shopSmsSettings,
  fill,
  queueSms,
  shopEvent,
  processQueue,
  startSmsWorker,
  sendDailySummaries,
  sendSubscriptionReminders,
  isConfigured: provider.isConfigured,
};
