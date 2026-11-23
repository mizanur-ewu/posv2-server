const dayjs = require("dayjs");
const bcrypt = require("bcryptjs");
const { prisma } = require("../config/db");
const apiError = require("./apiError");
const { logger } = require("./logger");
const { defaultRoles } = require("./permissions");
const { normEmail, normPhone, toDate } = require("./helperFunction");
const { isShopType, typeOptions, cleanText } = require("./shopTypes");

/* ---------------- platform settings (one row, cached a minute) ---------------- */
let cache = { at: 0, value: null };

const getPlatformSettings = async (fresh = false) => {
  if (!fresh && cache.value && Date.now() - cache.at < 60_000) return cache.value;
  const value = await prisma.platformSetting.upsert({ where: { id: "default" }, create: { id: "default" }, update: {} });
  cache = { at: Date.now(), value };
  return value;
};
const clearSettingsCache = () => {
  cache = { at: 0, value: null };
};

/* ---------------- billing state of a shop ---------------- */
/**
 * Where a shop stands. Dates are "YYYY-MM-DD" strings (or null).
 *   suspended – cannot sign in
 *   active    – paid (paidUntil today or later) or no end date at all
 *   trial     – in its free trial
 *   grace     – ended, still working for `graceDays`
 *   expired   – ended and past the grace period: read-only
 */
const billingOf = (store, settings, now = dayjs()) => {
  const today = now.format("YYYY-MM-DD");
  const graceDays = settings?.graceDays ?? 7;
  const paid = store.paidUntil || null;
  const trial = store.trialEndsAt || null;
  const base = { paidUntil: paid, trialEndsAt: trial, graceDays };
  const daysTo = (d) => dayjs(d).startOf("day").diff(now.startOf("day"), "day");

  if (store.status === "suspended") return { ...base, state: "suspended", readOnly: true, endsAt: null, daysLeft: null };
  if (!paid && !trial) return { ...base, state: "active", readOnly: false, endsAt: null, daysLeft: null, noEnd: true };
  if (paid && paid >= today) return { ...base, state: "active", readOnly: false, endsAt: paid, daysLeft: daysTo(paid) };
  if (trial && trial >= today && (!paid || trial > paid)) return { ...base, state: "trial", readOnly: false, endsAt: trial, daysLeft: daysTo(trial) };

  const ended = [paid, trial].filter(Boolean).sort().pop();
  const graceEndsAt = dayjs(ended).add(graceDays, "day").format("YYYY-MM-DD");
  if (graceEndsAt >= today) return { ...base, state: "grace", readOnly: false, endsAt: ended, graceEndsAt, daysLeft: daysTo(graceEndsAt) };
  return { ...base, state: "expired", readOnly: true, endsAt: ended, graceEndsAt, daysLeft: daysTo(ended) };
};

/* ---------------- audit ---------------- */
/** Write one line to the platform activity log. Never fails the request it belongs to. */
const audit = async (actor, action, { store = null, detail = null } = {}) => {
  try {
    await prisma.platformAudit.create({
      data: {
        actorId: actor?.id || null,
        actorName: actor?.name || "System",
        action,
        storeId: store?.id || null,
        storeName: store ? `${store.name} (${store.code})` : null,
        detail: detail ? String(detail).slice(0, 1000) : null,
      },
    });
  } catch (e) {
    logger.error(`Audit write failed: ${e.message}`);
  }
};

/* ---------------- logins are unique across shops and the platform ---------------- */
const loginTaken = async (client, { email, phone }, { exceptUserId, exceptPlatformId } = {}) => {
  const e = normEmail(email);
  if (e) {
    const [u, p] = await Promise.all([
      client.user.findFirst({ where: { email: e, ...(exceptUserId ? { id: { not: exceptUserId } } : {}) }, select: { id: true } }),
      client.platformUser.findFirst({ where: { email: e, ...(exceptPlatformId ? { id: { not: exceptPlatformId } } : {}) }, select: { id: true } }),
    ]);
    if (u || p) return `Email ${e} is already used by another account`;
  }
  const key = phone ? normPhone(phone) : null;
  if (key) {
    const u = await client.user.findFirst({ where: { phoneKey: key, ...(exceptUserId ? { id: { not: exceptUserId } } : {}) }, select: { id: true } });
    if (u) return `Phone ${phone} is already used by another account`;
  }
  return null;
};

/* ---------------- shop code ---------------- */
/** A short upper-case code from the shop name (RAHIM STORE → RS, then RS2 … if taken). Used in document numbers. */
const makeShopCode = async (client, name, wanted) => {
  const clean = (s) => String(s || "").toUpperCase().replace(/[^A-Z0-9]/g, "");
  if (wanted) {
    const code = clean(wanted).slice(0, 8);
    if (code.length < 2) throw apiError.badRequest("Shop code needs at least 2 letters or digits");
    if (await client.store.findUnique({ where: { code } })) throw apiError.conflict(`Shop code ${code} is already used`);
    return code;
  }
  const words = String(name || "").toUpperCase().replace(/[^A-Z0-9 ]/g, " ").split(/\s+/).filter(Boolean);
  let base = words.length > 1 ? words.map((w) => w[0]).join("").slice(0, 4) : clean(words[0]).slice(0, 4);
  if (base.length < 2) base = `SH${base}`;
  for (let i = 1; i < 1000; i += 1) {
    const code = i === 1 ? base : `${base}${i}`;
    if (!(await client.store.findUnique({ where: { code }, select: { id: true } }))) return code;
  }
  throw apiError.conflict("Could not make a shop code, enter one");
};

/** Ready-made lists so a shop that skips the setup assistant can still start selling. */
const STARTER_UNITS = ["Pcs", "Box", "Kg", "Gram", "Litre", "Dozen", "Packet"];
const STARTER_EXPENSES = ["Rent", "Salary", "Electricity", "Transport", "Others"];

/** Adds the starter units / expense categories when the shop has none yet. */
const ensureStarter = async (tx, tenant) => {
  const [units, expenses] = await Promise.all([tx.unit.count({ where: { storeId: tenant.storeId } }), tx.expenseCategory.count({ where: { storeId: tenant.storeId } })]);
  if (!units) await tx.unit.createMany({ data: STARTER_UNITS.map((n) => ({ ...tenant, name: n })) });
  if (!expenses) await tx.expenseCategory.createMany({ data: STARTER_EXPENSES.map((n) => ({ ...tenant, name: n })) });
};

/** Shop category, zilla and thana of a new shop: all three are needed. */
const shopPlace = ({ shopType, district, thana }) => {
  if (!isShopType(shopType)) throw apiError.badRequest("Select the shop category");
  const d = cleanText(district);
  if (!d) throw apiError.badRequest("Select the zilla");
  const th = cleanText(thana);
  if (!th) throw apiError.badRequest("Select or type the thana");
  return { shopType, district: d, thana: th };
};

/**
 * Create a shop: company, store, the four default roles and its admin (owner) login. Runs inside the
 * given transaction. Units, categories, brands … come from the setup assistant the owner sees first
 * (`setupPending`); skipping it adds the starter units and expense categories.
 */
const createShop = async (tx, { businessName, shopName, code, modules, planId, trialEndsAt, paidUntil, address, phone, source, owner, smsBalance = 0, shopType, district, thana }) => {
  const name = String(shopName || businessName || "").trim();
  if (!name) throw apiError.badRequest("Enter the shop name");
  const place = shopPlace({ shopType, district, thana });
  if (!String(owner?.name || "").trim()) throw apiError.badRequest("Enter the owner's name");
  if (!owner?.email && !owner?.phone) throw apiError.badRequest("Give the owner an email or phone number to log in with");
  if (String(owner?.password || "").length < 6) throw apiError.badRequest("Password must be at least 6 characters");
  const taken = await loginTaken(tx, owner);
  if (taken) throw apiError.conflict(taken);

  let plan = null;
  if (planId) {
    plan = await tx.plan.findUnique({ where: { id: planId } });
    if (!plan) throw apiError.badRequest("Select a plan");
  }
  const mod = ["pos", "dealer", "both"].includes(modules) ? modules : plan?.modules || "both";

  const company = await tx.company.create({ data: { name: String(businessName || name).trim() } });
  const store = await tx.store.create({
    data: {
      code: await makeShopCode(tx, name, code),
      name,
      companyId: company.id,
      subscription: mod,
      planId: plan?.id || null,
      trialEndsAt: trialEndsAt ? toDate(trialEndsAt) : null,
      paidUntil: paidUntil ? toDate(paidUntil) : null,
      address: address || null,
      phone: phone || owner.phone || null,
      source: source || "admin",
      smsBalance: Math.max(0, parseInt(smsBalance, 10) || 0),
      ...place,
      ...typeOptions(place.shopType),
      setupPending: true,
    },
  });
  const tenant = { storeId: store.id, companyId: company.id };

  let adminRole = null;
  for (const r of defaultRoles()) {
    const role = await tx.role.create({ data: { ...tenant, ...r } });
    if (r.key === "admin") adminRole = role;
  }

  const email = normEmail(owner.email) || null;
  const ownerPhone = owner.phone ? String(owner.phone).trim() : null;
  const user = await tx.user.create({
    data: {
      ...tenant,
      name: String(owner.name).trim(),
      email,
      phone: ownerPhone,
      phoneKey: ownerPhone ? normPhone(ownerPhone) || null : null,
      loginWith: email ? "email" : "phone",
      password: await bcrypt.hash(String(owner.password), 10),
      roleId: adminRole.id,
    },
  });
  return { company, store, user };
};

/* ---------------- user limit of the plan ---------------- */
/** Throws when the shop's plan has no room for one more active user. */
const checkUserLimit = async (client, storeId) => {
  const store = await client.store.findUnique({ where: { id: storeId }, include: { plan: { select: { name: true, maxUsers: true } } } });
  const max = store?.plan?.maxUsers;
  if (!max) return;
  const active = await client.user.count({ where: { storeId, status: "active" } });
  if (active >= max) {
    throw apiError.badRequest(`The ${store.plan.name} plan allows ${max} active users. Deactivate a user or ask for a bigger plan.`);
  }
};

module.exports = { getPlatformSettings, clearSettingsCache, billingOf, audit, loginTaken, makeShopCode, createShop, checkUserLimit, ensureStarter, STARTER_UNITS };
