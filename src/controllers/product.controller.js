const dayjs = require("dayjs");
const { logger } = require("../utils/logger");
const { prisma } = require("../config/db");
const apiError = require("../utils/apiError");
const { r2, r3, tenant, ctxOf } = require("../utils/helperFunction");
const { stockTransaction, nextCounter } = require("../utils/stock/stockWork");
const { createStock } = require("../utils/stock/stockEntry");

/* ---------------- products ---------------- */

/**
 * Products with names of category / brand / unit and stock totals of their SKUs.
 * A product with variants (hasVariants) is listed with its variants' stock added up; each variant
 * is also in the list (parentId set) – the UI shows them under their parent.
 */
exports.getAllProduct = async (req, res, next) => {
  try {
    const where = { storeId: req.storeId };
    const [products, skus, serials] = await Promise.all([
      prisma.product.findMany({
        where,
        orderBy: { createdAt: "asc" },
        include: {
          category: { select: { name: true } },
          brand: { select: { name: true } },
          unit: { select: { name: true } },
        },
      }),
      prisma.stockSummary.findMany({
        where,
        select: { productId: true, stockQuantity: true, issuedQuantity: true, sellingPrice: true },
      }),
      prisma.serialNumber.groupBy({ by: ["productId"], where: { ...where, status: "in_stock" }, _count: { _all: true } }),
    ]);
    const serialCount = new Map(serials.map((s) => [s.productId, s._count._all]));

    const rows = products.map(({ category, brand, unit, ...p }) => {
      const own = skus.filter((s) => s.productId === p.id);
      return {
        ...p,
        fullName: p.variantName ? `${p.name} (${p.variantName})` : p.name,
        category: category?.name,
        brand: brand?.name,
        unit: unit?.name,
        stockQuantity: r3(own.reduce((a, s) => a + s.stockQuantity, 0)),
        issuedQuantity: r3(own.reduce((a, s) => a + s.issuedQuantity, 0)),
        skuPrices: own.filter((s) => s.stockQuantity > 0).map((s) => s.sellingPrice).sort((a, b) => a - b),
        serialsInStock: serialCount.get(p.id) || 0,
      };
    });
    // a parent shows its variants' totals
    const data = rows.map((p) => {
      if (!p.hasVariants) return p;
      const kids = rows.filter((v) => v.parentId === p.id);
      return {
        ...p,
        variantCount: kids.length,
        stockQuantity: r3(kids.reduce((a, v) => a + v.stockQuantity, 0)),
        issuedQuantity: r3(kids.reduce((a, v) => a + v.issuedQuantity, 0)),
        skuPrices: [...new Set(kids.flatMap((v) => v.skuPrices))].sort((a, b) => a - b),
        serialsInStock: kids.reduce((a, v) => a + v.serialsInStock, 0),
      };
    });

    return res.status(200).json({ status: "success", results: data.length, data });
  } catch (error) {
    logger.error(`Products retrieval error: ${error.message}`);
    next(error);
  }
};

const checkBarcode = async (storeId, barcode, exceptIds = []) => {
  if (!barcode) return;
  const used = await prisma.product.findFirst({
    where: { storeId, barcode, ...(exceptIds.length ? { id: { notIn: exceptIds } } : {}) },
    select: { id: true },
  });
  if (used) throw apiError.conflict(`Barcode ${barcode} is already used by another product`);
};

/** Validated product fields from the body (shared by create and update). */
const productFields = async (req, existingId) => {
  const { name, barcode, categoryId, brandId, unitId, vatPercent, purchasePrice, sellingPrice, status, trackSerial, warrantyMonths, warrantyNote } = req.body;
  const where = { storeId: req.storeId };
  const clean = {
    name: String(name || "").trim(),
    barcode: barcode ? String(barcode).trim() : null,
    categoryId: categoryId || null,
    brandId: brandId || null,
    unitId,
    vatPercent: Number(vatPercent) || 0,
    purchasePrice: r2(purchasePrice),
    sellingPrice: r2(sellingPrice),
    status: status === "inactive" ? "inactive" : "active",
    trackSerial: !!trackSerial,
    warrantyMonths: Math.max(0, Math.min(120, parseInt(warrantyMonths, 10) || 0)) || null,
    warrantyNote: warrantyNote ? String(warrantyNote).trim().slice(0, 200) : null,
  };
  if (!clean.name) throw apiError.badRequest("Product name is required");
  if (!unitId || !(await prisma.unit.findFirst({ where: { ...where, id: unitId } }))) throw apiError.badRequest("Select a unit");
  if (clean.categoryId && !(await prisma.category.findFirst({ where: { ...where, id: clean.categoryId } }))) throw apiError.badRequest("Category not found");
  if (clean.brandId && !(await prisma.brand.findFirst({ where: { ...where, id: clean.brandId } }))) throw apiError.badRequest("Brand not found");
  if (clean.vatPercent < 0 || clean.vatPercent > 100) throw apiError.badRequest("VAT must be between 0 and 100");
  if (clean.purchasePrice < 0 || clean.sellingPrice < 0) throw apiError.badRequest("Prices can't be negative");
  await checkBarcode(req.storeId, clean.barcode, existingId ? [existingId] : []);
  return clean;
};

/** Fields every variant takes from its parent. */
const SHARED = ["name", "categoryId", "brandId", "unitId", "vatPercent", "trackSerial", "warrantyMonths", "warrantyNote"];
const shared = (p) => Object.fromEntries(SHARED.map((k) => [k, p[k]]));

/** One variant line from the body: { id?, variantName, barcode, purchasePrice, sellingPrice, status, initialStock } */
const variantFields = (v, parent) => {
  const variantName = String(v.variantName || "").trim();
  if (!variantName) throw apiError.badRequest("Every variant needs a name, e.g. Red / XL");
  return {
    variantName,
    barcode: v.barcode ? String(v.barcode).trim() : null,
    purchasePrice: v.purchasePrice !== undefined && v.purchasePrice !== null && v.purchasePrice !== "" ? r2(v.purchasePrice) : parent.purchasePrice,
    sellingPrice: v.sellingPrice !== undefined && v.sellingPrice !== null && v.sellingPrice !== "" ? r2(v.sellingPrice) : parent.sellingPrice,
    status: v.status === "inactive" ? "inactive" : "active",
  };
};

const checkVariantList = async (storeId, list, exceptIds) => {
  const names = new Set();
  const codes = new Set();
  list.forEach((v) => {
    const k = v.variantName.toLowerCase();
    if (names.has(k)) throw apiError.badRequest(`Variant "${v.variantName}" is there twice`);
    names.add(k);
    if (v.barcode) {
      if (codes.has(v.barcode)) throw apiError.badRequest(`Barcode ${v.barcode} is used by two variants`);
      codes.add(v.barcode);
    }
  });
  for (const v of list) await checkBarcode(storeId, v.barcode, exceptIds);
};

/**
 * Create a product. `initialStock` > 0 also posts an "Opening stock" stock entry (no supplier)
 * at the product's default purchase / selling price.
 * With `variants: [...]` (shop option "variants") the product becomes a parent and each variant a
 * product of its own (own barcode, prices and stock); `initialStock` then goes per variant.
 */
exports.createProduct = async (req, res, next) => {
  try {
    const clean = await productFields(req);
    const variants = Array.isArray(req.body.variants) ? req.body.variants : [];
    const store = await prisma.store.findUnique({ where: { id: req.storeId }, select: { useVariants: true, useSerials: true } });
    if (variants.length && !store.useVariants) throw apiError.badRequest("Turn on product variants in Settings first");
    if (clean.trackSerial && !store.useSerials) throw apiError.badRequest("Turn on IMEI / serial numbers in Settings first");
    const quantity = Number(req.body.initialStock) || 0;
    if (clean.trackSerial && (quantity > 0 || variants.some((v) => Number(v.initialStock) > 0))) {
      throw apiError.badRequest("IMEI / serial products get their stock through Add Stock, where each IMEI is entered");
    }
    if (!variants.length && quantity > 0 && !(clean.sellingPrice > 0)) throw apiError.badRequest("Enter a selling price for the opening stock");
    const vList = variants.map((v) => ({ ...variantFields(v, clean), initialStock: Number(v.initialStock) || 0 }));
    if (variants.length) await checkVariantList(req.storeId, vList, []);
    vList.forEach((v) => {
      if (v.initialStock > 0 && !(v.sellingPrice > 0)) throw apiError.badRequest(`${v.variantName}: enter a selling price for the opening stock`);
    });

    const product = await stockTransaction(ctxOf(req), async (work) => {
      const n = await nextCounter(work.tx, work.ctx, "PRD");
      const code = `P${String(n).padStart(3, "0")}`;
      const created = await work.tx.product.create({
        data: { ...tenant(req), ...clean, ...(vList.length ? { hasVariants: true, barcode: null } : {}), code, createdById: req.user.id },
      });
      const opening = [];
      if (!vList.length && quantity > 0) {
        opening.push({ productId: created.id, quantity, purchasePrice: created.purchasePrice, sellingPrice: created.sellingPrice, vatPercent: created.vatPercent });
      }
      let i = 0;
      for (const v of vList) {
        i += 1;
        const variant = await work.tx.product.create({
          data: {
            ...tenant(req),
            ...shared(clean),
            parentId: created.id,
            variantName: v.variantName,
            barcode: v.barcode,
            purchasePrice: v.purchasePrice,
            sellingPrice: v.sellingPrice,
            status: v.status,
            code: `${code}-${i}`,
            createdById: req.user.id,
          },
        });
        if (v.initialStock > 0) opening.push({ productId: variant.id, quantity: v.initialStock, purchasePrice: variant.purchasePrice, sellingPrice: variant.sellingPrice, vatPercent: variant.vatPercent });
      }
      if (opening.length) await createStock(work, { date: dayjs(), remark: "Opening stock", lines: opening });
      return created;
    });

    return res.status(201).json({ status: "success", message: vList.length ? `Product created with ${vList.length} variants` : "Product created", data: product });
  } catch (error) {
    logger.error(`Product creation error: ${error.message}`);
    next(error);
  }
};

/** Units of a product (and of its variants) in hand: in store + out with SR / delivery men. */
const unitsInHand = async (storeId, productIds) => {
  const agg = await prisma.stockSummary.aggregate({ where: { storeId, productId: { in: productIds } }, _sum: { stockQuantity: true, issuedQuantity: true } });
  return r3(Number(agg._sum.stockQuantity || 0) + Number(agg._sum.issuedQuantity || 0));
};

/**
 * Edit a product. For a parent, the shared fields (name, category, brand, unit, VAT, IMEI, warranty)
 * go to every variant too; `variants: [...]` edits variants (with id) and adds new ones (without id).
 */
exports.updateProduct = async (req, res, next) => {
  try {
    const id = req.params.id;
    const existing = await prisma.product.findFirst({ where: { id, storeId: req.storeId } });
    if (!existing) throw apiError.notFound("Product not found");
    if (existing.parentId) throw apiError.badRequest("Edit a variant from its main product");
    const clean = await productFields(req, id);
    const kids = existing.hasVariants ? await prisma.product.findMany({ where: { storeId: req.storeId, parentId: id }, orderBy: { code: "asc" } }) : [];
    const family = [id, ...kids.map((k) => k.id)];

    // IMEI tracking can only start before there is stock, and stop when no IMEI unit is in stock
    if (clean.trackSerial !== existing.trackSerial) {
      const store = await prisma.store.findUnique({ where: { id: req.storeId }, select: { useSerials: true } });
      if (clean.trackSerial && !store.useSerials) throw apiError.badRequest("Turn on IMEI / serial numbers in Settings first");
      if (clean.trackSerial && (await unitsInHand(req.storeId, family)) > 0) {
        throw apiError.badRequest("This product already has stock without IMEI numbers. Turn IMEI tracking on before adding stock, or make a new product.");
      }
      if (!clean.trackSerial && (await prisma.serialNumber.count({ where: { storeId: req.storeId, productId: { in: family }, status: "in_stock" } }))) {
        throw apiError.badRequest("IMEI units of this product are still in stock, so tracking can't be turned off");
      }
    }

    const variants = Array.isArray(req.body.variants) ? req.body.variants : null;
    let vList = [];
    if (variants) {
      if (!existing.hasVariants && variants.length) {
        const store = await prisma.store.findUnique({ where: { id: req.storeId }, select: { useVariants: true } });
        if (!store.useVariants) throw apiError.badRequest("Turn on product variants in Settings first");
        if ((await unitsInHand(req.storeId, [id])) > 0) throw apiError.badRequest("This product has stock. Variants can only be added to a product without stock; make a new product with variants instead.");
      }
      vList = variants.map((v) => ({ id: v.id || null, ...variantFields(v, clean) }));
      if (vList.some((v) => v.id && !kids.some((k) => k.id === v.id))) throw apiError.badRequest("Variant not found");
      const keepNames = kids.filter((k) => !vList.some((v) => v.id === k.id)).map((k) => ({ variantName: k.variantName, barcode: k.barcode }));
      await checkVariantList(req.storeId, [...vList, ...keepNames], family);
    }

    const product = await prisma.$transaction(async (tx) => {
      const isParent = existing.hasVariants || vList.length > 0;
      const saved = await tx.product.update({ where: { id }, data: { ...clean, ...(isParent ? { hasVariants: true, barcode: null } : {}) } });
      if (kids.length) await tx.product.updateMany({ where: { storeId: req.storeId, parentId: id }, data: shared(clean) });
      let n = kids.length;
      for (const v of vList) {
        if (v.id) {
          await tx.product.update({ where: { id: v.id }, data: { variantName: v.variantName, barcode: v.barcode, purchasePrice: v.purchasePrice, sellingPrice: v.sellingPrice, status: v.status } });
        } else {
          n += 1;
          let code = `${existing.code}-${n}`;
          while (await tx.product.findFirst({ where: { storeId: req.storeId, code }, select: { id: true } })) code = `${existing.code}-${(n += 1)}`;
          await tx.product.create({
            data: { ...tenant(req), ...shared(clean), parentId: id, variantName: v.variantName, barcode: v.barcode, purchasePrice: v.purchasePrice, sellingPrice: v.sellingPrice, status: v.status, code, createdById: req.user.id },
          });
        }
      }
      return saved;
    });
    return res.status(200).json({ status: "success", message: "Product updated", data: product });
  } catch (error) {
    logger.error(`Product update error: ${error.message}`);
    next(error);
  }
};

/* ---------------- categories / brands / units ---------------- */
const MASTER = {
  categories: { model: "category", field: "categoryId", label: "Category" },
  brands: { model: "brand", field: "brandId", label: "Brand" },
  units: { model: "unit", field: "unitId", label: "Unit" },
};

const masterOf = (kind) => {
  const m = MASTER[kind];
  if (!m) throw apiError.notFound("Unknown list");
  return m;
};

/** Case-insensitive duplicate name check. */
const checkMasterName = async (m, storeId, name, exceptId) => {
  const dup = await prisma[m.model].findFirst({
    where: { storeId, name: { equals: name, mode: "insensitive" }, ...(exceptId ? { id: { not: exceptId } } : {}) },
    select: { id: true },
  });
  if (dup) throw apiError.conflict(`${m.label} "${name}" already exists`);
};

exports.getMasters = async (req, res, next) => {
  try {
    const m = masterOf(req.params.kind);
    const [list, counts] = await Promise.all([
      prisma[m.model].findMany({ where: { storeId: req.storeId }, orderBy: { name: "asc" } }),
      prisma.product.groupBy({ by: [m.field], where: { storeId: req.storeId }, _count: { _all: true } }),
    ]);
    const data = list.map((x) => ({ ...x, productCount: counts.find((c) => c[m.field] === x.id)?._count._all || 0 }));
    return res.status(200).json({ status: "success", data });
  } catch (error) {
    logger.error(`Master list error: ${error.message}`);
    next(error);
  }
};

exports.createMaster = async (req, res, next) => {
  try {
    const m = masterOf(req.params.kind);
    const name = String(req.body.name || "").trim();
    if (!name) throw apiError.badRequest("Name is required");
    await checkMasterName(m, req.storeId, name);
    const item = await prisma[m.model].create({ data: { ...tenant(req), name } });
    return res.status(201).json({ status: "success", message: `${m.label} created`, data: item });
  } catch (error) {
    logger.error(`Master creation error: ${error.message}`);
    next(error);
  }
};

exports.updateMaster = async (req, res, next) => {
  try {
    const m = masterOf(req.params.kind);
    const id = req.params.id;
    const name = String(req.body.name || "").trim();
    if (!name) throw apiError.badRequest("Name is required");
    if (!(await prisma[m.model].findFirst({ where: { id, storeId: req.storeId } }))) throw apiError.notFound(`${m.label} not found`);
    await checkMasterName(m, req.storeId, name, id);
    const item = await prisma[m.model].update({ where: { id }, data: { name } });
    return res.status(200).json({ status: "success", message: `${m.label} updated`, data: item });
  } catch (error) {
    logger.error(`Master update error: ${error.message}`);
    next(error);
  }
};

exports.deleteMaster = async (req, res, next) => {
  try {
    const m = masterOf(req.params.kind);
    const id = req.params.id;
    if (!(await prisma[m.model].findFirst({ where: { id, storeId: req.storeId } }))) throw apiError.notFound(`${m.label} not found`);
    const used = await prisma.product.count({ where: { storeId: req.storeId, [m.field]: id } });
    if (used) throw apiError.badRequest(`Used by ${used} product(s). Move them first.`);
    await prisma[m.model].delete({ where: { id } });
    return res.status(200).json({ status: "success", message: `${m.label} deleted`, data: null });
  } catch (error) {
    logger.error(`Master delete error: ${error.message}`);
    next(error);
  }
};
