const dayjs = require("dayjs");
const { r2, toDate, indexBy } = require("./helperFunction");
const { CASH } = require("./stock/constants");

/**
 * Every movement of money of a shop, from the records that already exist:
 *   in : sale payments and due collections (customer payments), SR / delivery cash deposited at a
 *        sales return, staff paying back their due
 *   out: customer refunds, expenses, supplier payments
 * Money an SR collects in the field is not in the shop yet: it counts when the SR deposits it
 * (ProductIssue.cashDeposited at the sales return), so customer payments with an issueId are left out.
 * A refund or an expense saved without a payment method counts as cash.
 *
 * moneyMoves(client, storeId, { from, to, userId, methodId }) → lines sorted by time.
 * from / to are "YYYY-MM-DD" (both included). userId = who recorded it (a cashier's drawer).
 */
const KIND_LABEL = {
  sale: "Sale payment",
  due_collection: "Due collected",
  sr_deposit: "SR / delivery cash deposited",
  staff_payment: "Staff paid their due",
  refund: "Refund to customer",
  expense: "Expense",
  supplier_payment: "Paid to supplier",
};

const moneyMoves = async (client, storeId, { from, to, userId = null, methodId = null }) => {
  const where = { storeId };
  const dRange = { gte: toDate(from), lte: toDate(to) };
  const tRange = { gte: dayjs(from).startOf("day").toDate(), lte: dayjs(to).endOf("day").toDate() };
  const by = (field) => (userId ? { [field]: userId } : {});

  const [payments, returns, expenses, supplierPays, staffPays, deposits, methods, users] = await Promise.all([
    client.customerPayment.findMany({
      where: { ...where, issueId: null, date: dRange, ...by("createdById") },
      include: { invoice: { select: { invoiceNo: true, soldToId: true } } },
    }),
    client.salesReturn.findMany({ where: { ...where, refundAmount: { gt: 0 }, returnDate: tRange, ...by("createdById") }, include: { invoice: { select: { invoiceNo: true } } } }),
    client.expense.findMany({ where: { ...where, date: dRange, ...by("createdById") }, include: { category: { select: { name: true } } } }),
    client.supplierPayment.findMany({ where: { ...where, date: dRange, ...by("createdById") } }),
    client.staffDue.findMany({ where: { ...where, kind: "payment", date: dRange, ...by("createdById") } }),
    client.productIssue.findMany({ where: { ...where, status: "settled", cashDeposited: { gt: 0 }, settledAt: tRange, ...by("settledById") }, select: { id: true, issueNo: true, employeeId: true, cashDeposited: true, settledAt: true, settledById: true } }),
    client.paymentMethod.findMany(),
    client.user.findMany({ where, select: { id: true, name: true } }),
  ]);

  const needCustomers = new Set([...payments.map((p) => p.customerId || p.invoice?.soldToId), ...returns.map((r) => r.customerId)].filter(Boolean));
  const supplierIds = new Set(supplierPays.map((p) => p.supplierId).filter(Boolean));
  const employeeIds = new Set([...deposits.map((d) => d.employeeId), ...staffPays.filter((s) => s.partyKey.startsWith("emp:")).map((s) => s.partyKey.slice(4))]);
  const [customers, suppliers, employees, stocks] = await Promise.all([
    needCustomers.size ? client.customer.findMany({ where: { id: { in: [...needCustomers] } }, select: { id: true, name: true } }) : [],
    supplierIds.size ? client.supplier.findMany({ where: { id: { in: [...supplierIds] } }, select: { id: true, name: true } }) : [],
    employeeIds.size ? client.employee.findMany({ where: { id: { in: [...employeeIds] } }, select: { id: true, name: true } }) : [],
    supplierPays.some((p) => p.stockId) ? client.stock.findMany({ where: { id: { in: supplierPays.map((p) => p.stockId).filter(Boolean) } }, select: { id: true, code: true } }) : [],
  ]);
  const C = indexBy(customers);
  const Su = indexBy(suppliers);
  const E = indexBy(employees);
  const St = indexBy(stocks);
  const M = indexBy(methods);
  const U = indexBy(users);

  const lines = [];
  const add = (l) => {
    const m = l.methodId || CASH;
    if (methodId && m !== methodId) return;
    lines.push({ ...l, methodId: m, method: M.get(m)?.name || "Cash", user: U.get(l.userId)?.name || "—", label: KIND_LABEL[l.kind], in: r2(l.in || 0), out: r2(l.out || 0) });
  };

  payments.forEach((p) =>
    add({
      id: `cp:${p.id}`,
      at: p.createdAt,
      date: p.date,
      kind: p.dueCollection ? "due_collection" : "sale",
      ref: p.invoice?.invoiceNo,
      party: C.get(p.customerId || p.invoice?.soldToId)?.name || "Walk-in customer",
      methodId: p.paymentMethodId,
      userId: p.createdById,
      in: p.amount,
    }),
  );
  deposits.forEach((d) =>
    add({ id: `is:${d.id}`, at: d.settledAt, date: dayjs(d.settledAt).format("YYYY-MM-DD"), kind: "sr_deposit", ref: d.issueNo, party: E.get(d.employeeId)?.name, methodId: CASH, userId: d.settledById, in: d.cashDeposited }),
  );
  staffPays.forEach((s) =>
    add({
      id: `sd:${s.id}`,
      at: s.createdAt,
      date: s.date,
      kind: "staff_payment",
      party: s.partyKey.startsWith("emp:") ? E.get(s.partyKey.slice(4))?.name : U.get(s.partyKey.slice(5))?.name,
      note: s.remark,
      methodId: s.paymentMethodId,
      userId: s.createdById,
      in: s.amount,
    }),
  );
  returns.forEach((r) =>
    add({ id: `sr:${r.id}`, at: r.returnDate, date: dayjs(r.returnDate).format("YYYY-MM-DD"), kind: "refund", ref: `${r.returnNo} (${r.invoice?.invoiceNo || ""})`, party: C.get(r.customerId)?.name || "Walk-in customer", methodId: r.paymentMethodId, userId: r.createdById, out: r.refundAmount }),
  );
  expenses.forEach((e) => add({ id: `ex:${e.id}`, at: e.createdAt, date: e.date, kind: "expense", ref: e.category?.name, note: e.remark, methodId: e.paymentMethodId, userId: e.createdById, out: e.amount }));
  supplierPays.forEach((p) =>
    add({ id: `sp:${p.id}`, at: p.createdAt, date: p.date, kind: "supplier_payment", ref: St.get(p.stockId)?.code || "Old due", party: Su.get(p.supplierId)?.name, note: p.remark, methodId: p.paymentMethodId, userId: p.createdById, out: p.amount }),
  );

  return lines.sort((a, b) => String(a.date).localeCompare(String(b.date)) || new Date(a.at) - new Date(b.at));
};

/**
 * Money in − out before a day (for the cash book's opening balance), with the same rules as moneyMoves.
 * methodId = one method (null = every method).
 */
const balanceBefore = async (client, storeId, day, methodId = null) => {
  const where = { storeId };
  const dBefore = { lt: toDate(day) };
  const tBefore = { lt: dayjs(day).startOf("day").toDate() };
  const m = (field, cashWhenNull = false) => {
    if (!methodId) return {};
    if (cashWhenNull && methodId === CASH) return { OR: [{ [field]: CASH }, { [field]: null }] };
    return { [field]: methodId };
  };
  const sum = (x) => Number(x?._sum?.amount || x?._sum?.refundAmount || x?._sum?.cashDeposited || 0);
  const [pay, dep, staff, ref, exp, sup] = await Promise.all([
    client.customerPayment.aggregate({ where: { ...where, issueId: null, date: dBefore, ...m("paymentMethodId") }, _sum: { amount: true } }),
    !methodId || methodId === CASH ? client.productIssue.aggregate({ where: { ...where, status: "settled", settledAt: tBefore }, _sum: { cashDeposited: true } }) : null,
    client.staffDue.aggregate({ where: { ...where, kind: "payment", date: dBefore, ...m("paymentMethodId", true) }, _sum: { amount: true } }),
    client.salesReturn.aggregate({ where: { ...where, returnDate: tBefore, ...m("paymentMethodId", true) }, _sum: { refundAmount: true } }),
    client.expense.aggregate({ where: { ...where, date: dBefore, ...m("paymentMethodId", true) }, _sum: { amount: true } }),
    client.supplierPayment.aggregate({ where: { ...where, date: dBefore, ...m("paymentMethodId") }, _sum: { amount: true } }),
  ]);
  return r2(sum(pay) + sum(dep) + sum(staff) - sum(ref) - sum(exp) - sum(sup));
};

module.exports = { moneyMoves, balanceBefore, KIND_LABEL };
