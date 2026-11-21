/**
 * Starting data: price plans, platform settings and the platform owner,
 * one company + store, payment methods, roles and the demo users.
 * Everything else (products, stock, sales …) is entered by the user.
 * Safe to run again: existing rows are kept.
 *
 *   npm run seed
 */
require("dotenv").config();
const bcrypt = require("bcryptjs");
const { PrismaClient } = require("@prisma/client");
const { defaultRoles } = require("../src/utils/permissions");

const prisma = new PrismaClient();

const PAYMENT_METHODS = [
  { id: "pm_cash", name: "Cash", sortOrder: 1 },
  { id: "pm_card", name: "Card", sortOrder: 2 },
  { id: "pm_mfs", name: "Mobile Banking", sortOrder: 3 },
  { id: "pm_bank", name: "Bank Transfer", sortOrder: 4 },
];

const STORE = { code: "DHK", name: "Dhanmondi Central Store", subscription: "both" };
const COMPANY = { name: "Stockflow Demo Ltd." };

/** Demo accounts listed on the login page. SRs sign in with their phone number, everyone else with email. */
const DEMO_USERS = [
  { name: "Mizanur Rahman", email: "admin@demo.com", phone: "01700000001", role: "admin" },
  { name: "Farhana Akter", email: "manager@demo.com", phone: "01700000002", role: "manager" },
  { name: "Tanvir Hasan", email: "cashier@demo.com", phone: "01700000003", role: "cashier" },
  { name: "Sabbir Rahman", email: "sabbir@demo.com", phone: "01700000004", role: "sr", loginWith: "phone", srEmployee: true },
];

/** Starter price plans (prices in BDT per month / year – edit them in the admin console). */
const PLANS = [
  { id: "plan_pos", name: "Shop", description: "For a retail counter: stock, POS sales, dues and reports.", modules: "pos", priceMonthly: 500, priceYearly: 5000, maxUsers: 3, sortOrder: 1 },
  { id: "plan_dealer", name: "Dealer", description: "For distributors: retailers, SR orders, sales out and sales return.", modules: "dealer", priceMonthly: 1000, priceYearly: 10000, maxUsers: 10, sortOrder: 2 },
  { id: "plan_both", name: "Business", description: "Everything: shop counter and field sales, unlimited users.", modules: "both", priceMonthly: 1500, priceYearly: 15000, maxUsers: null, sortOrder: 3 },
];

/** The person who runs the platform (sees every shop). Listed on the login page while it has DEMO_PASSWORD. */
const PLATFORM_OWNER = { name: "Platform Owner", email: process.env.PLATFORM_OWNER_EMAIL || "platform@demo.com" };

async function main() {
  for (const pm of PAYMENT_METHODS) {
    await prisma.paymentMethod.upsert({ where: { id: pm.id }, create: pm, update: { name: pm.name, sortOrder: pm.sortOrder } });
  }

  // ---- SaaS platform ----
  for (const p of PLANS) {
    await prisma.plan.upsert({ where: { id: p.id }, create: p, update: {} });
  }
  await prisma.platformSetting.upsert({
    where: { id: "default" },
    create: { id: "default", brandName: "Stockflow", trialDays: 14, graceDays: 7, signupEnabled: true, signupPlanId: "plan_both" },
    update: {},
  });
  if (!(await prisma.platformUser.findUnique({ where: { email: PLATFORM_OWNER.email } }))) {
    await prisma.platformUser.create({
      data: { ...PLATFORM_OWNER, role: "owner", isDemo: true, password: await bcrypt.hash(process.env.DEMO_PASSWORD || "demo1234", 10) },
    });
    console.log(`Created platform owner ${PLATFORM_OWNER.email}`);
  }

  let store = await prisma.store.findUnique({ where: { code: STORE.code } });
  if (!store) {
    const company = await prisma.company.create({ data: COMPANY });
    store = await prisma.store.create({ data: { ...STORE, companyId: company.id, planId: "plan_both" } });
    console.log(`Created store ${store.code}`);
  } else if (!store.planId) {
    store = await prisma.store.update({ where: { id: store.id }, data: { planId: "plan_both" } });
  }
  const tenant = { storeId: store.id, companyId: store.companyId };

  const roles = {};
  for (const r of defaultRoles()) {
    roles[r.key] =
      (await prisma.role.findFirst({ where: { storeId: store.id, key: r.key } })) ||
      (await prisma.role.create({ data: { ...tenant, ...r } }));
  }

  const password = await bcrypt.hash(process.env.DEMO_PASSWORD || "demo1234", 10);
  for (const u of DEMO_USERS) {
    let user = await prisma.user.findUnique({ where: { email: u.email } });
    if (!user) {
      user = await prisma.user.create({
        data: {
          ...tenant,
          name: u.name,
          email: u.email,
          phone: u.phone,
          phoneKey: u.phone,
          password,
          loginWith: u.loginWith || "email",
          roleId: roles[u.role].id,
          isDemo: true,
        },
      });
      console.log(`Created user ${u.email}`);
    }
    // the order-taking SR employee behind the demo SR login
    if (u.srEmployee && !(await prisma.employee.findFirst({ where: { storeId: store.id, userId: user.id } }))) {
      await prisma.employee.create({
        data: { ...tenant, type: "sr", srMode: "orders", name: u.name, phone: u.phone, userId: user.id, status: "active" },
      });
    }
  }
  // pages added later get their default rights in every shop's Manager / Cashier role (only when missing)
  const NEW_PAGE_DEFAULTS = {
    manager: { cashClosing: ["view", "create"], warranty: ["view", "create", "edit"] },
    cashier: { cashClosing: ["create"], warranty: ["view", "create"] },
  };
  for (const [key, pages] of Object.entries(NEW_PAGE_DEFAULTS)) {
    for (const role of await prisma.role.findMany({ where: { key } })) {
      const perms = { ...(role.permissions || {}) };
      let changed = false;
      for (const [page, actions] of Object.entries(pages)) {
        if (!perms[page]) {
          perms[page] = actions;
          changed = true;
        }
      }
      if (changed) await prisma.role.update({ where: { id: role.id }, data: { permissions: perms } });
    }
  }
  console.log("Seed done");
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
