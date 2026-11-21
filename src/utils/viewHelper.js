const { r2, r3, indexBy } = require("./helperFunction");
const { lotAvailable } = require("./stock/stockWork");
const { issueSkuSummary } = require("./stock/dealer");
const { invoiceDeleteBlockReason } = require("./stock/sales");

/**
 * Builds the response shapes the frontend works with (product names, units, customer names …
 * spread into every row), from rows loaded for one store.
 */

const discountLabel = (d) => (d.mode === "percentage" ? `${d.value}% off` : `৳${d.perUnit} off`);

/** A user without the password – the only shape the UI ever gets. */
const safeUser = ({ password, phoneKey, isDemo, store, role, ...u }) => ({ ...u, demo: !!isDemo, hasPassword: !!password });

/**
 * Everything most views need, loaded in parallel: products, units, categories, brands, users,
 * employees, customers, SKUs, discounts, payment methods. `lots: true` also loads every lot.
 */
const loadLookups = async (client, storeId, { lots = false } = {}) => {
  const where = { storeId };
  const [products, units, categories, brands, users, employees, customers, skus, discounts, paymentMethods, allLots] = await Promise.all([
    client.product.findMany({ where }),
    client.unit.findMany({ where, select: { id: true, name: true } }),
    client.category.findMany({ where, select: { id: true, name: true } }),
    client.brand.findMany({ where, select: { id: true, name: true } }),
    client.user.findMany({ where, select: { id: true, name: true, roleId: true, phone: true, status: true } }),
    client.employee.findMany({ where }),
    client.customer.findMany({ where }),
    client.stockSummary.findMany({ where, orderBy: { createdAt: "asc" } }),
    client.discount.findMany({ where }),
    client.paymentMethod.findMany({ orderBy: { sortOrder: "asc" } }),
    lots ? client.stockDetails.findMany({ where }) : null,
  ]);

  const L = {
    products: indexBy(products),
    units: indexBy(units),
    categories: indexBy(categories),
    brands: indexBy(brands),
    users: indexBy(users),
    employees: indexBy(employees),
    customers: indexBy(customers),
    skus: indexBy(skus),
    discounts: indexBy(discounts),
    paymentMethods: indexBy(paymentMethods),
    skuList: skus,
    lots: allLots,
  };

  /** Product name with its unit, category and brand – spread into every line view. */
  /** "T-Shirt (Red / XL)" for a variant, the plain name otherwise. */
  L.fullName = (p) => (p ? (p.variantName ? `${p.name} (${p.variantName})` : p.name) : "—");
  L.pInfo = (productId) => {
    const p = L.products.get(productId);
    return {
      productName: L.fullName(p),
      trackSerial: !!p?.trackSerial,
      warrantyMonths: p?.warrantyMonths || 0,
      unit: L.units.get(p?.unitId)?.name || "",
      category: L.categories.get(p?.categoryId)?.name || null,
      brand: L.brands.get(p?.brandId)?.name || null,
    };
  };
  L.pName = (id) => L.fullName(L.products.get(id));
  L.cName = (id) => (id ? L.customers.get(id)?.name : "Walk-in Customer") || "—";
  L.eName = (id) => L.employees.get(id)?.name || "—";
  L.uName = (id) => L.users.get(id)?.name || "—";
  L.method = (id) => L.paymentMethods.get(id)?.name;
  L.skuCode = (id) => L.skus.get(id)?.sku;

  /** Discount info for a SKU that was split off by a discount (null for a regular SKU). */
  L.skuDiscount = (sku) => {
    if (!sku?.discountId) return null;
    const d = L.discounts.get(sku.discountId);
    if (!d) return null;
    return { id: d.id, label: discountLabel(d), regularPrice: d.regularPrice, perUnit: d.perUnit, endDate: d.endDate, status: d.status };
  };
  return L;
};

/** Lots grouped by SKU id. */
const lotsBySku = (lots) => {
  const map = new Map();
  (lots || []).forEach((l) => {
    if (!map.has(l.stockSummaryId)) map.set(l.stockSummaryId, []);
    map.get(l.stockSummaryId).push(l);
  });
  return map;
};

/* ---------------- SKU ---------------- */
const skuView = (L, sku, lots = []) => {
  const p = L.products.get(sku.productId);
  const activeLots = lots.filter((l) => lotAvailable(l) > 0);
  const nearestExpiry = activeLots.map((l) => l.expiryDate).filter(Boolean).sort()[0] || null;
  return {
    ...sku,
    ...L.pInfo(sku.productId),
    productCode: p?.code,
    barcode: p?.barcode,
    categoryId: p?.categoryId,
    brandId: p?.brandId,
    discount: L.skuDiscount(sku),
    vatPercent: p?.vatPercent || 0,
    lotCount: activeLots.length,
    nearestExpiry,
    stockValueCost: r2(activeLots.reduce((a, l) => a + lotAvailable(l) * l.purchasePrice, 0)),
    stockValueSale: r2(sku.stockQuantity * sku.sellingPrice),
  };
};

/** Every SKU view (L must be loaded with lots). */
const skuViews = (L, skus = L.skuList) => {
  const byS = lotsBySku(L.lots);
  return skus.map((s) => skuView(L, s, byS.get(s.id) || []));
};

/* ---------------- invoice ---------------- */
const numberMaps = async (client, { issueIds = [], orderIds = [] }) => {
  const iIds = [...new Set(issueIds.filter(Boolean))];
  const oIds = [...new Set(orderIds.filter(Boolean))];
  const [issues, orders] = await Promise.all([
    iIds.length ? client.productIssue.findMany({ where: { id: { in: iIds } }, select: { id: true, issueNo: true } }) : [],
    oIds.length ? client.salesOrder.findMany({ where: { id: { in: oIds } }, select: { id: true, orderNo: true } }) : [],
  ]);
  return { issueNo: new Map(issues.map((i) => [i.id, i.issueNo])), orderNo: new Map(orders.map((o) => [o.id, o.orderNo])) };
};

/** Invoices (loaded with details, and payments when withDetails) → list / detail views. */
const invoiceViews = async (client, L, invoices, { withDetails = false } = {}) => {
  const nos = await numberMaps(client, { issueIds: invoices.map((i) => i.issueId), orderIds: invoices.map((i) => i.salesOrderId) });
  let lots = new Map();
  let returns = [];
  let serials = [];
  if (withDetails && invoices.length) {
    const lotIds = [...new Set(invoices.flatMap((i) => i.details.map((d) => d.stockDetailsId)))];
    const [lotRows, retRows, serialRows] = await Promise.all([
      client.stockDetails.findMany({ where: { id: { in: lotIds } }, select: { id: true, seq: true, expiryDate: true } }),
      client.salesReturn.findMany({ where: { invoiceId: { in: invoices.map((i) => i.id) } }, include: { details: true }, orderBy: { returnDate: "asc" } }),
      client.serialNumber.findMany({ where: { invoiceId: { in: invoices.map((i) => i.id) } }, select: { id: true, serial: true, productId: true, invoiceId: true, status: true, warrantyUntil: true }, orderBy: { serial: "asc" } }),
    ]);
    lots = indexBy(lotRows);
    returns = retRows;
    serials = serialRows;
  }

  return invoices.map((inv) => {
    const details = inv.details || [];
    const v = {
      ...inv,
      customer: L.cName(inv.soldToId),
      customerType: L.customers.get(inv.soldToId)?.customerType || "walk_in",
      sr: inv.srId ? L.eName(inv.srId) : null,
      deliveryMan: inv.deliveryManId ? L.eName(inv.deliveryManId) : null,
      soldBy: L.uName(inv.soldById),
      issueNo: inv.issueId ? nos.issueNo.get(inv.issueId) || null : null,
      orderNo: inv.salesOrderId ? nos.orderNo.get(inv.salesOrderId) || null : null,
      cost: r2(details.reduce((a, d) => a + (d.salesQuantity - d.returnedQuantity) * d.purchasePrice, 0)),
      itemCount: details.length,
    };
    // sales without VAT, after returns (returns carry their VAT share)
    const exVat = inv.totalAmount > 0 ? (inv.totalAmount - inv.vatAmount) / inv.totalAmount : 1;
    v.profit = r2((inv.totalAmount - inv.returnedAmount) * exVat - v.cost);
    if (withDetails) {
      v.details = details.map((d) => {
        const sku = L.skus.get(d.stockSummaryId);
        const lot = lots.get(d.stockDetailsId);
        return { ...d, ...L.pInfo(d.productId), sku: sku?.sku, skuDiscount: L.skuDiscount(sku), lotNo: lot?.seq, expiryDate: lot?.expiryDate };
      });
      // grouped by SKU for printing
      const g = {};
      v.details.forEach((d) => {
        const k = `${d.stockSummaryId}|${d.unitPrice}`;
        g[k] ||= {
          key: k,
          productId: d.productId,
          productName: d.productName,
          unit: d.unit,
          category: d.category,
          brand: d.brand,
          sku: d.sku,
          skuDiscount: d.skuDiscount,
          unitPrice: d.unitPrice,
          warrantyMonths: d.warrantyMonths || 0,
          quantity: 0,
          discount: 0,
          total: 0,
          returned: 0,
        };
        g[k].quantity = r3(g[k].quantity + d.salesQuantity);
        g[k].discount = r2(g[k].discount + d.discountAmount);
        g[k].total = r2(g[k].total + d.total);
        g[k].returned = r3(g[k].returned + d.returnedQuantity);
      });
      // IMEI / serials sold on this invoice (still sold = not returned), listed under their product
      v.serials = serials.filter((x) => x.invoiceId === inv.id);
      const used = new Set();
      v.grouped = Object.values(g).map((x) => {
        const mine = v.serials.filter((sr) => sr.productId === x.productId && sr.status === "sold" && !used.has(sr.id));
        mine.forEach((sr) => used.add(sr.id));
        return { ...x, serials: mine.map((sr) => sr.serial), warrantyUntil: mine[0]?.warrantyUntil || null };
      });
      v.payments = (inv.payments || []).map((p) => ({ ...p, method: L.method(p.paymentMethodId) }));
      v.returns = returns.filter((r) => r.invoiceId === inv.id);
      v.deleteBlockReason = invoiceDeleteBlockReason(inv, { issueNo: v.issueNo, orderNo: v.orderNo });
    }
    return v;
  });
};

/* ---------------- order ---------------- */
/** Orders (loaded with details) → views. */
const orderViews = async (client, L, orders) => {
  const nos = await numberMaps(client, { issueIds: orders.map((o) => o.issueId || o.closedIssueId) });
  const invoices = orders.length
    ? await client.salesInvoice.findMany({
        where: { salesOrderId: { in: orders.map((o) => o.id) } },
        select: { id: true, invoiceNo: true, totalAmount: true, viaApp: true, salesOrderId: true },
        orderBy: { soldDate: "asc" },
      })
    : [];
  return orders.map((o) => {
    const c = L.customers.get(o.customerId);
    const details = o.details || [];
    return {
      ...o,
      customer: c?.name,
      customerPhone: c?.phone,
      customerAddress: c?.address,
      routeId: c?.routeId,
      route: L.routes?.get(c?.routeId)?.name,
      sr: L.eName(o.srId),
      deliveryMan: o.deliveryManId ? L.eName(o.deliveryManId) : null,
      issueNo: o.issueId || o.closedIssueId ? nos.issueNo.get(o.issueId || o.closedIssueId) || null : null,
      details: details.map((d) => {
        const sku = L.skus.get(d.stockSummaryId);
        return {
          ...d,
          ...L.pInfo(d.productId),
          sku: sku?.sku,
          skuDiscount: L.skuDiscount(sku),
          remaining: r3(d.quantity - d.deliveredQuantity),
          skuStock: sku?.stockQuantity,
        };
      }),
      deliveredAmount: r2(details.reduce((a, d) => a + d.deliveredQuantity * d.unitPrice, 0)),
      remainingAmount: r2(details.reduce((a, d) => a + (d.quantity - d.deliveredQuantity) * d.unitPrice, 0)),
      invoices: invoices.filter((i) => i.salesOrderId === o.id).map(({ salesOrderId, ...i }) => i),
    };
  });
};

/** Routes are only needed by order views – load them into L. */
const withRoutes = async (client, L, storeId) => {
  if (!L.routes) L.routes = indexBy(await client.route.findMany({ where: { storeId }, select: { id: true, name: true, areaId: true } }));
  return L;
};

/* ---------------- issue ---------------- */
const ORDER_INCLUDE = { details: { orderBy: { line: "asc" } } };

/** Issues (loaded with details + expenses) → views; full adds lots, orders, invoices and adjustments. */
const issueViews = async (client, L, issues, { full = false } = {}) => {
  if (!issues.length) return [];
  const ids = issues.map((i) => i.id);
  const storeId = issues[0].storeId;
  const orders = await client.salesOrder.findMany({
    where: { storeId, OR: [{ issueId: { in: ids } }, { issueHistory: { hasSome: ids } }] },
    include: full ? ORDER_INCLUDE : undefined,
    orderBy: { orderDate: "asc" },
  });
  const ordersOf = (id) => orders.filter((o) => o.issueId === id || (o.issueHistory || []).includes(id));

  let extra = null;
  if (full) {
    await withRoutes(client, L, storeId);
    const lotIds = [...new Set(issues.flatMap((i) => i.details.map((d) => d.stockDetailsId)))];
    const [lots, invoices, adjustments] = await Promise.all([
      client.stockDetails.findMany({ where: { id: { in: lotIds } } }),
      client.salesInvoice.findMany({
        where: { storeId, issueId: { in: ids } },
        include: { details: { orderBy: { line: "asc" } }, payments: { orderBy: { line: "asc" } } },
        orderBy: { soldDate: "asc" },
      }),
      client.stockAdjustment.findMany({ where: { storeId, issueId: { in: ids } }, orderBy: { createdAt: "asc" } }),
    ]);
    extra = {
      lots: indexBy(lots),
      orderViews: indexBy(await orderViews(client, L, orders)),
      invoiceViews: await invoiceViews(client, L, invoices, { withDetails: true }),
      adjustments,
    };
  }

  return issues.map((issue) => {
    const summary = issueSkuSummary(issue.details).map((m) => {
      const sku = L.skus.get(m.skuId);
      return { ...m, ...L.pInfo(m.productId), sku: sku?.sku, skuDiscount: L.skuDiscount(sku), sellingPrice: sku?.sellingPrice, value: r2(m.issued * (sku?.sellingPrice || 0)) };
    });
    const tripOrders = ordersOf(issue.id);
    const v = {
      ...issue,
      employee: L.eName(issue.employeeId),
      employeeHasUser: !!L.employees.get(issue.employeeId)?.userId,
      issuedBy: L.uName(issue.issuedById),
      settledBy: issue.settledById ? L.uName(issue.settledById) : null,
      editedBy: issue.editedById ? L.uName(issue.editedById) : null,
      totalIssuedQty: r3(summary.reduce((a, m) => a + m.issued, 0)),
      totalIssuedValue: r2(summary.reduce((a, m) => a + m.value, 0)),
      skuCount: summary.length,
      orderCount: tripOrders.length,
    };
    if (full) {
      v.summary = summary;
      v.lots = issue.details.map((d) => {
        const lot = extra.lots.get(d.stockDetailsId);
        return { ...d, ...L.pInfo(d.productId), sku: L.skuCode(d.stockSummaryId), lotNo: lot?.seq, expiryDate: lot?.expiryDate, purchasePrice: lot?.purchasePrice };
      });
      v.orders = tripOrders.map((o) => extra.orderViews.get(o.id));
      v.invoices = extra.invoiceViews.filter((i) => i.issueId === issue.id);
      v.adjustments = extra.adjustments
        .filter((a) => a.issueId === issue.id)
        .map((a) => ({ ...a, ...L.pInfo(extra.lots.get(a.stockDetailsId)?.productId) }));
    }
    return v;
  });
};

const ISSUE_INCLUDE = { details: { orderBy: { line: "asc" } }, expenses: true };

/**
 * What a saved sales return entered, in the shape the Sales Return form uses.
 * (Read before the settlement is undone.)
 */
const settlementEntries = async (client, L, issue) => {
  const invs = await client.salesInvoice.findMany({
    where: { storeId: issue.storeId, issueId: issue.id, fromSettlement: true },
    include: { details: { orderBy: { line: "asc" } }, payments: true },
    orderBy: { soldDate: "asc" },
  });
  const paidOnTrip = (inv) => r2(inv.payments.filter((p) => p.issueId === issue.id).reduce((a, p) => a + p.amount, 0));
  const invoices = invs
    .filter((i) => i.channel === "sr_sale")
    .map((inv) => {
      const lines = {};
      inv.details.forEach((d) => {
        const key = `${d.stockSummaryId}|${d.unitPrice}`;
        lines[key] ||= { skuId: d.stockSummaryId, unitPrice: d.unitPrice, quantity: 0 };
        lines[key].quantity = r3(lines[key].quantity + d.salesQuantity);
      });
      return { customerId: inv.soldToId, lines: Object.values(lines), paid: paidOnTrip(inv) };
    });

  const orderIds = [...new Set(invs.filter((i) => i.salesOrderId).map((i) => i.salesOrderId))];
  const orders = orderIds.length ? await client.salesOrder.findMany({ where: { id: { in: orderIds } }, include: { details: true } }) : [];
  const deliveries = {};
  invs
    .filter((i) => i.salesOrderId)
    .forEach((inv) => {
      const o = orders.find((x) => x.id === inv.salesOrderId);
      if (!o) return;
      const dv = (deliveries[o.id] ||= { lines: {}, collected: 0 });
      inv.details.forEach((d) => {
        const od = o.details.find((x) => x.stockSummaryId === d.stockSummaryId);
        if (od) dv.lines[od.id] = r3((dv.lines[od.id] || 0) + d.salesQuantity);
      });
      dv.collected = r2(dv.collected + paidOnTrip(inv));
    });

  const returns = {};
  issue.details.forEach((d) => {
    returns[d.stockSummaryId] = r3((returns[d.stockSummaryId] || 0) + d.returnedQuantity);
  });
  return {
    mode: invoices.length && invoices.every((i) => i.customerId) ? "retailer" : "consolidated",
    invoices,
    deliveries,
    returns,
    expenses: (issue.expenses || []).map(({ expenseHead, amount, remark }) => ({ expenseHead, amount, remark })),
    cashDeposited: issue.cashDeposited,
    settledAt: issue.settledAt,
    settledBy: L.uName(issue.settledById),
  };
};

module.exports = {
  discountLabel,
  safeUser,
  loadLookups,
  lotsBySku,
  skuView,
  skuViews,
  invoiceViews,
  orderViews,
  withRoutes,
  issueViews,
  settlementEntries,
  ISSUE_INCLUDE,
  ORDER_INCLUDE,
};
