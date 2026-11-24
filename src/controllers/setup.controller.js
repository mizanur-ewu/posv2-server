const { logger } = require("../utils/logger");
const { prisma } = require("../config/db");
const apiError = require("../utils/apiError");
const { r2, tenant } = require("../utils/helperFunction");
const { nextCounter } = require("../utils/stock/stockWork");
const { ensureStarter } = require("../utils/platform");
const { isShopType, cleanText } = require("../utils/shopTypes");
const { cleanMethodIds } = require("../utils/stock/constants");

/* ---------------- setup assistant ---------------- */
/*
 * A new shop's owner first sees the setup assistant (client: pages/setup/SetupWizard). It suggests units,
 * categories, brands, expense categories, suppliers and sample products for the kind of shop; the owner
 * edits the lists and sends what they kept here. Names that already exist are reused, never doubled, so
 * the assistant can be run again later from Settings.
 */

const MAX_ROWS = 300;
const key = (s) => String(s || "").trim().toLowerCase();

/** A list of unique, trimmed names (case-insensitive). */
const nameList = (list, label) => {
  if (list === undefined || list === null) return [];
  if (!Array.isArray(list)) throw apiError.badRequest(`${label}: send a list`);
  if (list.length > MAX_ROWS) throw apiError.badRequest(`${label}: at most ${MAX_ROWS} at a time`);
  const seen = new Set();
  const out = [];
  list.forEach((x) => {
    const name = cleanText(typeof x === "string" ? x : x?.name, 80);
    if (name && !seen.has(key(name))) {
      seen.add(key(name));
      out.push(name);
    }
  });
  return out;
};

/**
 * Creates the names missing from a master table (unit / category / brand / expenseCategory) and returns
 * a map lower-case name → id covering both the old and the new rows.
 */
const upsertNames = async (tx, model, ten, names) => {
  const existing = await tx[model].findMany({ where: { storeId: ten.storeId }, select: { id: true, name: true } });
  const ids = new Map(existing.map((r) => [key(r.name), r.id]));
  let added = 0;
  for (const name of names) {
    if (ids.has(key(name))) continue;
    const row = await tx[model].create({ data: { ...ten, name } });
    ids.set(key(name), row.id);
    added += 1;
  }
  return { ids, added };
};

const money = (v, label) => {
  const n = v === undefined || v === null || v === "" ? 0 : Number(v);
  if (!Number.isFinite(n) || n < 0) throw apiError.badRequest(`${label}: prices can't be negative`);
  return r2(n);
};

/**
 * Save what the owner kept in the setup assistant.
 * Body: { shopType?, useVariants?, useSerials?, allowDue?, payMethodIds?, units: [name], categories: [name], brands: [name],
 *         expenseCategories: [name], suppliers: [{ name, phone }],
 *         products: [{ name, category, brand, unit, purchasePrice, sellingPrice, trackSerial, warrantyMonths }] }
 * Products point at units / categories / brands by name (from the lists above or already in the shop).
 */
exports.applySetup = async (req, res, next) => {
  try {
    const b = req.body || {};
    if (b.shopType !== undefined && b.shopType !== null && !isShopType(b.shopType)) throw apiError.badRequest("Select the shop category");
    const units = nameList(b.units, "Units");
    const categories = nameList(b.categories, "Categories");
    const brands = nameList(b.brands, "Brands");
    const expenseCategories = nameList(b.expenseCategories, "Expense categories");
    if (b.suppliers !== undefined && !Array.isArray(b.suppliers)) throw apiError.badRequest("Suppliers: send a list");
    if (b.products !== undefined && !Array.isArray(b.products)) throw apiError.badRequest("Products: send a list");
    const suppliers = (b.suppliers || []).slice(0, MAX_ROWS).map((s) => ({ name: cleanText(s?.name, 80), phone: cleanText(s?.phone, 20) })).filter((s) => s.name);
    const products = (b.products || []).slice(0, MAX_ROWS).map((p, i) => {
      const name = cleanText(p?.name, 120);
      if (!name) throw apiError.badRequest(`Product ${i + 1}: enter a name`);
      const purchasePrice = money(p.purchasePrice, name);
      const sellingPrice = money(p.sellingPrice, name);
      const warrantyMonths = parseInt(p.warrantyMonths, 10);
      return {
        name,
        unit: cleanText(p.unit, 80),
        category: cleanText(p.category, 80),
        brand: cleanText(p.brand, 80),
        purchasePrice,
        sellingPrice,
        trackSerial: !!p.trackSerial,
        warrantyMonths: Number.isFinite(warrantyMonths) && warrantyMonths > 0 ? Math.min(warrantyMonths, 120) : null,
      };
    });

    const ten = tenant(req);
    const result = await prisma.$transaction(
      async (tx) => {
        const data = { setupPending: false };
        if (b.shopType) data.shopType = b.shopType;
        if (b.useVariants !== undefined) data.useVariants = !!b.useVariants;
        if (b.useSerials !== undefined) data.useSerials = !!b.useSerials;
        if (b.allowDue !== undefined) data.allowDue = !!b.allowDue;
        if (b.payMethodIds !== undefined) data.payMethodIds = cleanMethodIds(b.payMethodIds);
        const store = await tx.store.update({ where: { id: req.storeId }, data });

        // units the products need are added even when the owner removed them from the unit list
        const unitNames = nameList([...units, ...products.map((p) => p.unit).filter(Boolean)], "Units");
        const u = await upsertNames(tx, "unit", ten, unitNames);
        const c = await upsertNames(tx, "category", ten, nameList([...categories, ...products.map((p) => p.category).filter(Boolean)], "Categories"));
        const br = await upsertNames(tx, "brand", ten, nameList([...brands, ...products.map((p) => p.brand).filter(Boolean)], "Brands"));
        const ex = await upsertNames(tx, "expenseCategory", ten, expenseCategories);

        const oldSuppliers = new Set((await tx.supplier.findMany({ where: { storeId: req.storeId }, select: { name: true } })).map((s) => key(s.name)));
        let suppliersAdded = 0;
        for (const s of suppliers) {
          if (oldSuppliers.has(key(s.name))) continue;
          await tx.supplier.create({ data: { ...ten, name: s.name, phone: s.phone } });
          oldSuppliers.add(key(s.name));
          suppliersAdded += 1;
        }

        // a shop never ends up without units or expense categories
        await ensureStarter(tx, ten);
        const fallbackUnit = u.ids.size ? null : (await tx.unit.findFirst({ where: { storeId: req.storeId }, orderBy: { createdAt: "asc" } }))?.id;

        const oldProducts = new Set((await tx.product.findMany({ where: { storeId: req.storeId, parentId: null }, select: { name: true } })).map((p) => key(p.name)));
        let productsAdded = 0;
        for (const p of products) {
          if (oldProducts.has(key(p.name))) continue;
          const unitId = (p.unit && u.ids.get(key(p.unit))) || u.ids.values().next().value || fallbackUnit;
          const n = await nextCounter(tx, ten, "PRD");
          await tx.product.create({
            data: {
              ...ten,
              code: `P${String(n).padStart(3, "0")}`,
              name: p.name,
              unitId,
              categoryId: p.category ? c.ids.get(key(p.category)) || null : null,
              brandId: p.brand ? br.ids.get(key(p.brand)) || null : null,
              purchasePrice: p.purchasePrice,
              sellingPrice: p.sellingPrice,
              trackSerial: p.trackSerial && store.useSerials,
              warrantyMonths: p.trackSerial && store.useSerials ? p.warrantyMonths : null,
              createdById: req.user.id,
            },
          });
          oldProducts.add(key(p.name));
          productsAdded += 1;
        }
        return { units: u.added, categories: c.added, brands: br.added, expenseCategories: ex.added, suppliers: suppliersAdded, products: productsAdded };
      },
      { timeout: 30_000 },
    );

    logger.info(`Setup assistant done for store ${req.storeId}: ${JSON.stringify(result)}`);
    return res.status(200).json({ status: "success", message: "Your shop is set up", data: result });
  } catch (error) {
    logger.error(`Setup assistant error: ${error.message}`);
    next(error);
  }
};

/** Skip the setup assistant: the shop gets the starter units and expense categories if it has none. */
exports.skipSetup = async (req, res, next) => {
  try {
    await prisma.$transaction(async (tx) => {
      await ensureStarter(tx, tenant(req));
      await tx.store.update({ where: { id: req.storeId }, data: { setupPending: false } });
    });
    return res.status(200).json({ status: "success", message: "Setup skipped", data: null });
  } catch (error) {
    logger.error(`Skip setup error: ${error.message}`);
    next(error);
  }
};
