const dayjs = require("dayjs");
const { prisma } = require("../../config/db");
const apiError = require("../../utils/apiError");
const { getPlatformSettings, clearSettingsCache, audit } = require("../../utils/platform");
const sms = require("../../services/sms/sms");
const provider = require("../../services/sms/provider");

/** Gateway state, numbers for today / this month, settings and the latest messages of every shop. */
exports.getSmsOverview = async (req, res, next) => {
  try {
    const settings = await getPlatformSettings(true);
    const month = dayjs().startOf("month").toDate();
    const today = dayjs().startOf("day").toDate();
    const [byStatus, monthParts, todayCount, logs, stores] = await Promise.all([
      prisma.smsLog.groupBy({ by: ["status"], where: { createdAt: { gte: month } }, _count: { _all: true } }),
      prisma.smsLog.aggregate({ where: { status: "sent", createdAt: { gte: month } }, _sum: { parts: true } }),
      prisma.smsLog.count({ where: { status: "sent", createdAt: { gte: today } } }),
      prisma.smsLog.findMany({ orderBy: { createdAt: "desc" }, take: 500 }),
      prisma.store.findMany({ select: { id: true, name: true, code: true, smsBalance: true } }),
    ]);
    const S = new Map(stores.map((s) => [s.id, s]));
    const { senderId } = provider.config();
    return res.status(200).json({
      status: "success",
      data: {
        configured: provider.isConfigured(),
        senderId: senderId || null,
        settings: { smsLive: settings.smsLive, smsReminders: settings.smsReminders, smsFreeCredits: settings.smsFreeCredits },
        month: Object.fromEntries(byStatus.map((s) => [s.status, s._count._all])),
        partsThisMonth: monthParts._sum.parts || 0,
        sentToday: todayCount,
        creditsHeld: stores.reduce((a, s) => a + s.smsBalance, 0),
        logs: logs.map((l) => ({ ...l, shopName: l.storeId ? S.get(l.storeId)?.name || "(deleted shop)" : null, shopCode: l.storeId ? S.get(l.storeId)?.code : null })),
      },
    });
  } catch (error) {
    next(error);
  }
};

/** Body: { smsLive, smsReminders, smsFreeCredits }. Going live needs the gateway key in .env. */
exports.updateSmsSettings = async (req, res, next) => {
  try {
    const b = req.body;
    const data = {};
    if (b.smsLive !== undefined) {
      if (b.smsLive && !provider.isConfigured()) throw apiError.badRequest("Add SMS_API_KEY and SMS_SENDER_ID to the server .env first");
      data.smsLive = !!b.smsLive;
    }
    if (b.smsReminders !== undefined) data.smsReminders = !!b.smsReminders;
    if (b.smsFreeCredits !== undefined) data.smsFreeCredits = Math.max(0, Math.min(10000, parseInt(b.smsFreeCredits, 10) || 0));
    await prisma.platformSetting.upsert({ where: { id: "default" }, create: { id: "default", ...data }, update: data });
    clearSettingsCache();
    await audit(req.platformUser, "sms.settings", { detail: JSON.stringify(data) });
    return res.status(200).json({ status: "success", message: data.smsLive === true ? "SMS is live: messages are sent for real now" : "SMS settings saved", data: null });
  } catch (error) {
    next(error);
  }
};

/** A test message from the platform (free). Body: { to, message? } */
exports.sendTestSms = async (req, res, next) => {
  try {
    if (!sms.bdNumber(req.body.to)) throw apiError.badRequest("Enter a valid Bangladeshi mobile number");
    const s = await getPlatformSettings();
    const log = await sms.queueSms({ to: req.body.to, type: "test", message: String(req.body.message || `${s.brandName}: test message. SMS is working.`).slice(0, 480), createdById: req.platformUser.id });
    return res.status(200).json({ status: "success", message: s.smsLive ? "Test message is on its way" : "Saved in test mode (not sent). Switch SMS live to send for real.", data: log });
  } catch (error) {
    next(error);
  }
};

/** Add (or take back, with a minus amount) SMS credits of a shop. Body: { amount, note } */
exports.addShopCredits = async (req, res, next) => {
  try {
    const amount = parseInt(req.body.amount, 10);
    if (!amount || Math.abs(amount) > 100000) throw apiError.badRequest("Enter how many SMS credits");
    const store = await prisma.store.findUnique({ where: { id: req.params.id } });
    if (!store) throw apiError.notFound("Shop not found");
    if (store.smsBalance + amount < 0) throw apiError.badRequest(`The shop has only ${store.smsBalance} credits`);
    const updated = await prisma.store.update({ where: { id: store.id }, data: { smsBalance: { increment: amount } } });
    await audit(req.platformUser, "sms.credits", { store, detail: `${amount > 0 ? "+" : ""}${amount} credits → ${updated.smsBalance}${req.body.note ? ` · ${req.body.note}` : ""}` });
    return res.status(200).json({ status: "success", message: `${store.name} now has ${updated.smsBalance} SMS credits`, data: { smsBalance: updated.smsBalance } });
  } catch (error) {
    next(error);
  }
};
