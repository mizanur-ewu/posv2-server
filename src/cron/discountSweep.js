const { prisma } = require("../config/db");
const { logger } = require("../utils/logger");
const { needsSweep, stockTransaction } = require("../utils/stock/stockWork");

/**
 * Daily job: for every store, end discounts whose last day has passed and move the stock left
 * in them back to the regular SKU. (Reads do the same on demand; this keeps stock right even
 * when nobody opens the app.)
 */
const endExpiredDiscounts = async () => {
  const stores = await prisma.store.findMany({ select: { id: true, code: true, companyId: true } });
  for (const store of stores) {
    if (!(await needsSweep(prisma, store.id))) continue;
    await stockTransaction({ storeId: store.id, companyId: store.companyId, storeCode: store.code, userId: "system" }, async () => null);
    logger.info(`Discounts swept for store ${store.code}`);
  }
};

module.exports = { endExpiredDiscounts };
