const { prisma } = require("../config/db");

/**
 * Runs fn(tx) in one database transaction that holds the store's write lock.
 * Stock, invoices, issues … of one store never change at the same time, so the FEFO / FIFO
 * allocation and the SKU caches always see a consistent picture. Other stores are not blocked.
 */
const storeTransaction = (storeId, fn) =>
  prisma.$transaction(
    async (tx) => {
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${storeId}))`;
      return fn(tx);
    },
    { maxWait: 20000, timeout: 90000 },
  );

class DryRunResult {
  constructor(result) {
    this.result = result;
  }
}

/** Runs fn(tx) and throws its changes away (used to show a settled sales out as it was before). */
const dryRunTransaction = async (storeId, fn) => {
  try {
    await storeTransaction(storeId, async (tx) => {
      const result = await fn(tx);
      throw new DryRunResult(result);
    });
  } catch (e) {
    if (e instanceof DryRunResult) return e.result;
    throw e;
  }
  return null;
};

module.exports = { storeTransaction, dryRunTransaction };
