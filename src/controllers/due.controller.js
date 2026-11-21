const dayjs = require("dayjs");
const { randomUUID } = require("crypto");
const { logger } = require("../utils/logger");
const { prisma } = require("../config/db");
const apiError = require("../utils/apiError");
const { shopEvent, queueSms, shopSmsSettings, fill } = require("../services/sms/sms");
const { r2, toDate, tenant, ctxOf, indexBy } = require("../utils/helperFunction");
const { storeTransaction } = require("../utils/storeTransaction");
const { receivePayment } = require("../utils/stock/sales");

/**
 * Who can owe money besides customers:
 * 'emp:<employee id>' (SR / delivery man) and 'user:<user id>' (manager and other app users).
 */
const staffParties = async (client, storeId) => {
  const [employees, users] = await Promise.all([
    client.employee.findMany({ where: { storeId }, orderBy: { createdAt: "asc" } }),
    client.user.findMany({ where: { storeId }, include: { role: { select: { key: true, name: true } } }, orderBy: { createdAt: "asc" } }),
  ]);
  const linked = new Set(employees.map((e) => e.userId).filter(Boolean));
  return [
    ...employees.map((e) => ({ key: `emp:${e.id}`, kind: e.type === "sr" ? "sr" : "delivery_man", name: e.name, phone: e.phone, status: e.status })),
    ...users
      .filter((u) => !linked.has(u.id))
      .map((u) => ({ key: `user:${u.id}`, kind: u.role?.key === "manager" ? "manager" : "staff", role: u.role?.name, name: u.name, phone: u.phone, status: u.status })),
  ];
};

/**
 * Everything that changed staff members' due, oldest first. `amount` > 0 adds to the due, < 0 takes it down.
 * SRs and delivery men get one line per sales return (shortage + cash short, less cash excess);
 * the rest is entered on the Due page. Returns Map partyKey → lines.
 */
const staffLedgers = async (client, storeId) => {
  const where = { storeId };
  const [issues, shortages, dues, methods, users] = await Promise.all([
    client.productIssue.findMany({ where: { ...where, status: "settled" }, select: { id: true, issueNo: true, employeeId: true, settledAt: true, cashShortExcess: true } }),
    client.stockAdjustment.findMany({ where: { ...where, adjustmentType: "shortage" }, select: { issueId: true, amount: true } }),
    client.staffDue.findMany({ where }),
    client.paymentMethod.findMany(),
    client.user.findMany({ where, select: { id: true, name: true } }),
  ]);
  const M = indexBy(methods);
  const U = indexBy(users);
  const ledgers = new Map();
  const push = (key, line) => {
    if (!ledgers.has(key)) ledgers.set(key, []);
    ledgers.get(key).push(line);
  };

  issues.forEach((i) => {
    const shortage = r2(shortages.filter((a) => a.issueId === i.id).reduce((a, x) => a + (x.amount || 0), 0));
    const cash = r2(-(i.cashShortExcess || 0)); // + short, - excess
    const amount = r2(shortage + cash);
    if (!amount && !shortage && !cash) return;
    push(`emp:${i.employeeId}`, {
      id: `iss:${i.id}`,
      source: "sales_return",
      date: dayjs(i.settledAt).format("YYYY-MM-DD"),
      issueNo: i.issueNo,
      shortage,
      cashShort: Math.max(0, cash),
      cashExcess: Math.max(0, -cash),
      amount,
    });
  });
  dues.forEach((d) =>
    push(d.partyKey, {
      id: d.id,
      source: d.kind, // 'charge' | 'payment'
      manual: true,
      date: d.date,
      remark: d.remark,
      method: d.paymentMethodId ? M.get(d.paymentMethodId)?.name : null,
      by: U.get(d.createdById)?.name || "—",
      amount: d.kind === "payment" ? -d.amount : d.amount,
    }),
  );
  ledgers.forEach((lines) => lines.sort((a, b) => a.date.localeCompare(b.date) || (a.amount < b.amount ? 1 : -1)));
  return ledgers;
};

/** Due left and the date of the oldest unpaid part (payments clear the oldest dues first). */
const staffBalance = (lines) => {
  const queue = [];
  lines.forEach((l) => {
    if (l.amount > 0) queue.push({ date: l.date, left: l.amount });
    else {
      let pay = -l.amount;
      while (pay > 0.001 && queue.length) {
        const x = Math.min(pay, queue[0].left);
        queue[0].left = r2(queue[0].left - x);
        pay = r2(pay - x);
        if (queue[0].left <= 0.001) queue.shift();
      }
    }
  });
  return { due: r2(lines.reduce((a, l) => a + l.amount, 0)), oldest: queue[0]?.date || null };
};

const openInvoices = (client, storeId, customerId) =>
  client.salesInvoice.findMany({
    where: { storeId, totalDue: { gt: 0 }, ...(customerId ? { soldToId: customerId } : { soldToId: { not: null } }) },
    orderBy: { soldDate: "asc" },
  });

/** Everyone who owes money: customers (unpaid invoices) and staff (SR, delivery man, manager…). */
exports.getDues = async (req, res, next) => {
  try {
    const storeId = req.storeId;
    const [customers, routes, areas, invoices, parties, ledgers] = await Promise.all([
      prisma.customer.findMany({ where: { storeId } }),
      prisma.route.findMany({ where: { storeId }, select: { id: true, name: true } }),
      prisma.area.findMany({ where: { storeId }, select: { id: true, name: true } }),
      openInvoices(prisma, storeId),
      staffParties(prisma, storeId),
      staffLedgers(prisma, storeId),
    ]);
    const R = indexBy(routes);
    const A = indexBy(areas);

    const customerDues = customers
      .map((c) => {
        const invs = invoices.filter((i) => i.soldToId === c.id);
        return {
          key: `cus:${c.id}`,
          group: "customer",
          kind: c.customerType,
          name: c.name,
          phone: c.phone,
          place: R.get(c.routeId)?.name || A.get(c.areaId)?.name,
          due: r2(invs.reduce((a, i) => a + i.totalDue, 0)),
          oldest: invs[0]?.soldDate || null,
          invoices: invs.map((i) => ({
            id: i.id,
            invoiceNo: i.invoiceNo,
            soldDate: i.soldDate,
            channel: i.channel,
            totalAmount: r2(i.totalAmount - i.returnedAmount),
            paid: r2(i.totalPaid - i.refundedAmount),
            totalDue: i.totalDue,
          })),
        };
      })
      .filter((x) => x.due > 0);
    const staff = parties
      .map((p) => {
        const lines = ledgers.get(p.key) || [];
        return { ...p, group: "staff", lines, ...staffBalance(lines) };
      })
      .filter((x) => x.due > 0);

    const data = [...customerDues, ...staff].sort((a, b) => b.due - a.due);
    return res.status(200).json({ status: "success", data });
  } catch (error) {
    logger.error(`Dues retrieval error: ${error.message}`);
    next(error);
  }
};

/** People a due can be added for by hand: SRs, delivery men, managers and other staff. */
exports.getStaffParties = async (req, res, next) => {
  try {
    const data = (await staffParties(prisma, req.storeId)).filter((p) => p.status !== "inactive");
    return res.status(200).json({ status: "success", data });
  } catch (error) {
    logger.error(`Staff parties error: ${error.message}`);
    next(error);
  }
};

/** Add a due by hand for a staff member (advance, cash taken, damage…). */
exports.addStaffDue = async (req, res, next) => {
  try {
    const { partyKey, amount, date, remark } = req.body;
    const parties = await staffParties(prisma, req.storeId);
    if (!parties.some((p) => p.key === partyKey)) throw apiError.badRequest("Select who owes this");
    if (!(Number(amount) > 0)) throw apiError.badRequest("Enter an amount");
    if (!String(remark || "").trim()) throw apiError.badRequest("Write what this due is for");
    const due = await prisma.staffDue.create({
      data: {
        ...tenant(req),
        partyKey,
        kind: "charge",
        amount: r2(amount),
        date: toDate(date || dayjs()),
        remark: String(remark).trim(),
        createdById: req.user.id,
      },
    });
    return res.status(201).json({ status: "success", message: "Due added", data: due });
  } catch (error) {
    logger.error(`Staff due error: ${error.message}`);
    next(error);
  }
};

/** Remove a due or a payment that was entered by hand on the Due page. */
exports.deleteStaffDueEntry = async (req, res, next) => {
  try {
    const entry = await prisma.staffDue.findFirst({ where: { id: req.params.id, storeId: req.storeId } });
    if (!entry) throw apiError.notFound("Entry not found");
    await prisma.staffDue.delete({ where: { id: entry.id } });
    return res.status(200).json({ status: "success", message: "Entry deleted", data: true });
  } catch (error) {
    logger.error(`Staff due delete error: ${error.message}`);
    next(error);
  }
};

/**
 * Take a payment from anyone on the Due page (key = cus:/emp:/user:…).
 * A customer's payment clears their oldest invoices first.
 */
exports.collectDue = async (req, res, next) => {
  try {
    const { key, amount, paymentMethodId, date, remark } = req.body;
    const [type, id] = String(key || "").split(":");
    const amt = r2(Number(amount) || 0);
    if (!(amt > 0)) throw apiError.badRequest("Enter an amount");
    if (!paymentMethodId || !(await prisma.paymentMethod.findUnique({ where: { id: paymentMethodId } }))) {
      throw apiError.badRequest("Select a payment method");
    }
    const ctx = ctxOf(req);

    const result = await storeTransaction(req.storeId, async (tx) => {
      if (type === "cus") {
        const c = await tx.customer.findFirst({ where: { id, storeId: req.storeId } });
        if (!c) throw apiError.notFound("Customer not found");
        const invs = await openInvoices(tx, req.storeId, id);
        const due = r2(invs.reduce((a, i) => a + i.totalDue, 0));
        if (amt > due + 0.001) throw apiError.badRequest(`Amount is more than the due (${due})`);
        const collectionId = `dc_${randomUUID()}`;
        const paid = [];
        let left = amt;
        for (const inv of invs) {
          if (left <= 0) break;
          const a = r2(Math.min(left, inv.totalDue));
          await receivePayment(tx, ctx, inv.id, { amount: a, paymentMethodId, date, remark, collectionId });
          paid.push(inv.invoiceNo);
          left = r2(left - a);
        }
        return { customer: c.name, phone: c.phone, amount: amt, invoices: paid, dueLeft: r2(due - amt), isCustomer: true };
      }

      const party = (await staffParties(tx, req.storeId)).find((x) => x.key === key);
      if (!party) throw apiError.notFound("Not found");
      const { due } = staffBalance((await staffLedgers(tx, req.storeId)).get(key) || []);
      if (amt > due + 0.001) throw apiError.badRequest(`Amount is more than the due (${due})`);
      await tx.staffDue.create({
        data: {
          ...tenant(req),
          partyKey: key,
          kind: "payment",
          amount: amt,
          paymentMethodId,
          date: toDate(date || dayjs()),
          remark: remark || null,
          createdById: req.user.id,
        },
      });
      return { customer: party.name, amount: amt, dueLeft: r2(due - amt) };
    });

    if (result.isCustomer && result.phone) {
      shopEvent(req.storeId, "payment", result.phone, { customer: result.customer, amount: result.amount, due: result.dueLeft });
    }
    return res.status(200).json({ status: "success", message: "Payment received", data: result });
  } catch (error) {
    logger.error(`Due collection error: ${error.message}`);
    next(error);
  }
};

/**
 * SMS due reminders to customers. Body: { customerIds: [...] }.
 * Customers without a phone or without due are skipped (and listed in the answer).
 */
exports.sendDueReminders = async (req, res, next) => {
  try {
    const ids = Array.isArray(req.body.customerIds) ? req.body.customerIds.filter(Boolean) : [];
    if (!ids.length) throw apiError.badRequest("Select at least one customer");
    if (ids.length > 500) throw apiError.badRequest("Send to at most 500 customers at a time");
    const [store, customers, invoices] = await Promise.all([
      prisma.store.findUnique({ where: { id: req.storeId }, select: { name: true, smsSettings: true, smsBalance: true } }),
      prisma.customer.findMany({ where: { storeId: req.storeId, id: { in: ids } }, select: { id: true, name: true, phone: true } }),
      prisma.salesInvoice.findMany({ where: { storeId: req.storeId, soldToId: { in: ids }, totalDue: { gt: 0 } }, select: { soldToId: true, totalDue: true } }),
    ]);
    const s = shopSmsSettings(store);
    let queued = 0;
    const skipped = [];
    for (const c of customers) {
      const due = r2(invoices.filter((i) => i.soldToId === c.id).reduce((a, i) => a + i.totalDue, 0));
      if (!(due > 0)) {
        skipped.push({ name: c.name, reason: "No due" });
        continue;
      }
      if (!c.phone) {
        skipped.push({ name: c.name, reason: "No phone number" });
        continue;
      }
      const message = fill(s.templates.due_reminder, { shop: store.name, customer: c.name, due: due.toLocaleString("en-IN", { maximumFractionDigits: 2 }) });
      const log = await queueSms({ storeId: req.storeId, to: c.phone, message, type: "due_reminder", createdById: req.user.id });
      if (log.status === "queued") queued += 1;
      else skipped.push({ name: c.name, reason: log.error });
    }
    const msg = queued ? `${queued} reminder(s) are being sent` : "No reminder was sent";
    return res.status(200).json({ status: "success", message: msg, data: { queued, skipped } });
  } catch (error) {
    logger.error(`Due reminder error: ${error.message}`);
    next(error);
  }
};

/** Due collected after the fact, newest first: customer collections (one row per collection) and staff payments. */
exports.getDueCollections = async (req, res, next) => {
  try {
    const where = { storeId: req.storeId };
    const [payments, customers, methods, users, staffPays, parties] = await Promise.all([
      prisma.customerPayment.findMany({ where: { ...where, dueCollection: true }, include: { invoice: { select: { invoiceNo: true, soldToId: true } } } }),
      prisma.customer.findMany({ where, select: { id: true, name: true, customerType: true } }),
      prisma.paymentMethod.findMany(),
      prisma.user.findMany({ where, select: { id: true, name: true } }),
      prisma.staffDue.findMany({ where: { ...where, kind: "payment" } }),
      staffParties(prisma, req.storeId),
    ]);
    const C = indexBy(customers);
    const M = indexBy(methods);
    const U = indexBy(users);
    const P = indexBy(parties, "key");

    const rows = {};
    payments.forEach((p) => {
      const k = p.collectionId || p.id;
      const cus = C.get(p.invoice?.soldToId);
      rows[k] ||= {
        id: k,
        date: p.date,
        createdAt: p.createdAt || p.date,
        name: p.invoice?.soldToId ? cus?.name || "—" : "Walk-in Customer",
        kind: cus?.customerType || "walk_in",
        method: M.get(p.paymentMethodId)?.name,
        by: U.get(p.createdById)?.name || "—",
        remark: p.remark,
        amount: 0,
        invoices: [],
      };
      rows[k].amount = r2(rows[k].amount + p.amount);
      rows[k].invoices.push(p.invoice?.invoiceNo);
    });
    staffPays.forEach((d) => {
      rows[d.id] = {
        id: d.id,
        date: d.date,
        createdAt: d.createdAt || d.date,
        name: P.get(d.partyKey)?.name || "—",
        kind: P.get(d.partyKey)?.kind,
        method: M.get(d.paymentMethodId)?.name,
        by: U.get(d.createdById)?.name || "—",
        remark: d.remark,
        amount: d.amount,
        invoices: [],
      };
    });
    const data = Object.values(rows).sort((a, b) => b.createdAt.localeCompare(a.createdAt));
    return res.status(200).json({ status: "success", data });
  } catch (error) {
    logger.error(`Due collections error: ${error.message}`);
    next(error);
  }
};

module.exports.staffParties = staffParties;
module.exports.staffLedgers = staffLedgers;
module.exports.staffBalance = staffBalance;
