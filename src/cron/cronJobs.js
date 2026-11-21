const { CronJob } = require("cron");
const { logger } = require("../utils/logger");
const { endExpiredDiscounts } = require("./discountSweep");
const { startSmsWorker, sendDailySummaries, sendSubscriptionReminders } = require("../services/sms/sms");

const TZ = process.env.TZ || "Asia/Dhaka";
const job = (when, name, fn) =>
  new CronJob(
    when,
    async () => {
      try {
        await fn();
      } catch (error) {
        logger.error(`${name} cron failed: ${error.message}`);
      }
    },
    null,
    true,
    TZ,
  );

// 00:01 every day (store time zone): discounts past their last day end, their stock goes back
job("0 1 0 * * *", "Discount sweep", endExpiredDiscounts);
// 10:00: SMS shop owners whose trial / subscription is about to end
job("0 0 10 * * *", "Subscription reminders", sendSubscriptionReminders);
// 21:30: today's numbers to shop owners who turned the daily summary on
job("0 30 21 * * *", "Daily SMS summary", sendDailySummaries);

// queued SMS go out every few seconds
startSmsWorker();

logger.info("⏰ Cron jobs initialized");
