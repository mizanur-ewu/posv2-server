const { logger } = require("../utils/logger");
const { prisma } = require("../config/db");
const apiError = require("../utils/apiError");
const { r2, ctxOf } = require("../utils/helperFunction");
const { roleCan } = require("../utils/permissions");
const { dryRunTransaction } = require("../utils/storeTransaction");
const { stockTransaction, StockWork } = require("../utils/stock/stockWork");
const {
  createIssue,
  cancelIssue,
  deleteIssue,
  settleIssue,
  unsettleIssue,
  updateSettlement,
  deleteSettlement,
} = require("../utils/stock/dealer");
const { loadLookups, issueViews, settlementEntries, ISSUE_INCLUDE } = require("../utils/viewHelper");

const issueView = async (client, storeId, id, { full = false } = {}) => {
  const issue = await client.productIssue.findFirst({ where: { id, storeId }, include: ISSUE_INCLUDE });
  if (!issue) return null;
  const L = await loadLookups(client, storeId);
  return (await issueViews(client, L, [issue], { full }))[0];
};

/** Without "change price" on Sales Return, SR sale lines must use the SKU price. */
const checkSettlementPrices = async (req) => {
  if (roleCan(req.role, req.subscription, "settlement", "changePrice")) return;
  const lines = (req.body.invoices || []).flatMap((i) => i.lines || []).filter((l) => l.unitPrice != null);
  if (!lines.length) return;
  const skus = await prisma.stockSummary.findMany({
    where: { storeId: req.storeId, id: { in: lines.map((l) => l.skuId) } },
    select: { id: true, sellingPrice: true },
  });
  if (lines.some((l) => r2(l.unitPrice) !== r2(skus.find((s) => s.id === l.skuId)?.sellingPrice))) {
    throw apiError.forbidden("You can't change the price");
  }
};

/** Sales outs. Filters: status, type. */
exports.getAllIssues = async (req, res, next) => {
  try {
    const where = { storeId: req.storeId };
    if (req.query.status) where.status = req.query.status;
    if (req.query.type) where.type = req.query.type;
    const [L, issues] = await Promise.all([
      loadLookups(prisma, req.storeId),
      prisma.productIssue.findMany({ where, include: ISSUE_INCLUDE, orderBy: [{ date: "desc" }, { issueNo: "desc" }] }),
    ]);
    const data = await issueViews(prisma, L, issues);
    return res.status(200).json({ status: "success", results: data.length, data });
  } catch (error) {
    logger.error(`Issues retrieval error: ${error.message}`);
    next(error);
  }
};

exports.getIssueById = async (req, res, next) => {
  try {
    const data = await issueView(prisma, req.storeId, req.params.id, { full: true });
    if (!data) throw apiError.notFound("Sales out not found");
    return res.status(200).json({ status: "success", data });
  } catch (error) {
    logger.error(`Issue retrieval error: ${error.message}`);
    next(error);
  }
};

exports.createIssue = async (req, res, next) => {
  try {
    const { type, employeeId, date, lines, orderIds } = req.body;
    const issue = await stockTransaction(ctxOf(req), (work) =>
      createIssue(work, { type, employeeId, date, lines: Array.isArray(lines) ? lines : [], orderIds: Array.isArray(orderIds) ? orderIds : [] }),
    );
    logger.info(`Sales out ${issue.issueNo} created by ${req.user.id}`);
    return res.status(201).json({ status: "success", message: `Sales out ${issue.issueNo} saved`, data: await issueView(prisma, req.storeId, issue.id) });
  } catch (error) {
    logger.error(`Issue creation error: ${error.message}`);
    next(error);
  }
};

exports.cancelIssue = async (req, res, next) => {
  try {
    const issue = await stockTransaction(ctxOf(req), (work) => cancelIssue(work, req.params.id));
    return res.status(200).json({ status: "success", message: `${issue.issueNo} cancelled`, data: await issueView(prisma, req.storeId, issue.id) });
  } catch (error) {
    logger.error(`Issue cancel error: ${error.message}`);
    next(error);
  }
};

exports.deleteIssue = async (req, res, next) => {
  try {
    const result = await stockTransaction(ctxOf(req), (work) => deleteIssue(work, req.params.id));
    logger.info(`Sales out ${result.issueNo} deleted by ${req.user.id}`);
    return res.status(200).json({ status: "success", message: `${result.issueNo} deleted`, data: result });
  } catch (error) {
    logger.error(`Issue delete error: ${error.message}`);
    next(error);
  }
};

/* ---------------- sales return (settlement) ---------------- */

exports.settleIssue = async (req, res, next) => {
  try {
    await checkSettlementPrices(req);
    const issue = await stockTransaction(ctxOf(req), (work) => settleIssue(work, req.params.id, req.body));
    logger.info(`Sales return saved for ${issue.issueNo} by ${req.user.id}`);
    return res.status(200).json({ status: "success", message: "Sales return saved", data: await issueView(prisma, req.storeId, issue.id) });
  } catch (error) {
    logger.error(`Settlement error: ${error.message}`);
    next(error);
  }
};

/** A settled sales out shown as it was before its sales return, plus what that sales return entered. */
exports.getSettlementDraft = async (req, res, next) => {
  try {
    const id = req.params.id;
    const ctx = ctxOf(req);
    const data = await dryRunTransaction(req.storeId, async (tx) => {
      const issue = await tx.productIssue.findFirst({ where: { id, storeId: req.storeId }, include: ISSUE_INCLUDE });
      if (!issue) throw apiError.notFound("Sales out not found");
      const prior = await settlementEntries(tx, await loadLookups(tx, req.storeId), issue);
      const work = new StockWork(tx, ctx);
      await unsettleIssue(work, id, { checkStock: false });
      await work.flush();
      return { issue: await issueView(tx, req.storeId, id, { full: true }), prior };
    });
    return res.status(200).json({ status: "success", data });
  } catch (error) {
    logger.error(`Settlement draft error: ${error.message}`);
    next(error);
  }
};

exports.updateSettlement = async (req, res, next) => {
  try {
    await checkSettlementPrices(req);
    const issue = await stockTransaction(ctxOf(req), (work) => updateSettlement(work, req.params.id, req.body));
    logger.info(`Sales return of ${issue.issueNo} edited by ${req.user.id}`);
    return res.status(200).json({ status: "success", message: "Sales return updated", data: await issueView(prisma, req.storeId, issue.id) });
  } catch (error) {
    logger.error(`Settlement update error: ${error.message}`);
    next(error);
  }
};

exports.deleteSettlement = async (req, res, next) => {
  try {
    const issue = await stockTransaction(ctxOf(req), (work) => deleteSettlement(work, req.params.id));
    logger.info(`Sales return of ${issue.issueNo} deleted by ${req.user.id}`);
    return res.status(200).json({ status: "success", message: "Sales return deleted", data: await issueView(prisma, req.storeId, issue.id) });
  } catch (error) {
    logger.error(`Settlement delete error: ${error.message}`);
    next(error);
  }
};
