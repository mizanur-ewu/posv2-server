/**
 * Pages and actions a role can be given (same list as the frontend's Settings → Roles).
 * A role stores { pageKey: [actions] } in Role.permissions.
 */
const PAGES = [
  { key: "dashboard", label: "Dashboard", actions: ["view"] },
  { key: "pos", label: "New Sales / POS Sales", actions: ["view", "create", "changePrice", "discount"] },
  { key: "invoices", label: "Sales History", actions: ["view", "create", "cancel", "delete"] },
  { key: "returns", label: "Customer Returns", actions: ["view", "create"] },
  { key: "stock", label: "Add Stock / Stock History", actions: ["view", "create", "edit", "delete"] },
  { key: "adjustments", label: "Stock Return and Adjustment", actions: ["view", "create", "edit", "delete"] },
  { key: "inventory", label: "Current Stock", actions: ["view"] },
  { key: "discounts", label: "Discount", actions: ["view", "create", "edit"] },
  { key: "barcodes", label: "Barcodes Print", actions: ["view"] },
  { key: "products", label: "Products, Categories, Brand, Unit", actions: ["view", "create", "edit"] },
  { key: "supplierPayments", label: "Supplier Payments", actions: ["view", "create"] },
  { key: "customerDues", label: "Due", actions: ["view", "create", "delete"] },
  { key: "expenses", label: "Expense", actions: ["view", "create", "edit", "delete"] },
  { key: "myOrders", label: "My Sales Order", actions: ["view", "create", "cancel"] },
  { key: "orders", label: "All Sales Order and Delivery", actions: ["view", "create", "cancel", "edit", "delete"] },
  { key: "issues", label: "Sales Out / All Sales Out", actions: ["view", "create", "cancel", "delete"] },
  { key: "settlement", label: "Sales Return", actions: ["view", "create", "changePrice", "edit", "delete"] },
  { key: "retailers", label: "Retailers", actions: ["view", "create", "edit"] },
  { key: "employees", label: "SR & Delivery", actions: ["view", "create", "edit"] },
  { key: "cashClosing", label: "Day close (cash)", actions: ["view", "create", "delete"] },
  { key: "warranty", label: "IMEI & Warranty", actions: ["view", "create", "edit"] },
  { key: "reports", label: "Reports", actions: ["view"] },
  { key: "settings", label: "Settings", actions: ["view", "edit"] },
];

/** Pages each subscription plan opens (same as the frontend's AppContext). */
const COMMON = ["dashboard", "products", "stock", "adjustments", "inventory", "discounts", "barcodes", "supplierPayments", "customerDues", "expenses", "invoices", "returns", "reports", "settings", "cashClosing", "warranty"];
const DEALER = ["retailers", "employees", "myOrders", "orders", "issues", "settlement"];
const MODULE_PAGES = {
  pos: [...COMMON, "pos"],
  dealer: [...COMMON, ...DEALER],
  both: [...COMMON, "pos", ...DEALER],
};

/** Every page with every action – the Admin (system) role. */
const fullPermissions = () => Object.fromEntries(PAGES.map((p) => [p.key, [...p.actions]]));

/** Roles every new store starts with. */
const defaultRoles = () => {
  const full = fullPermissions();
  return [
    { key: "admin", name: "Admin", system: true, permissions: full },
    {
      key: "manager",
      name: "Manager",
      system: false,
      permissions: {
        ...full,
        settings: ["view"],
        invoices: ["view", "create", "cancel"],
        orders: ["view", "create", "cancel"],
        issues: ["view", "create", "cancel"],
        settlement: ["view", "create", "changePrice"],
        cashClosing: ["view", "create"],
      },
    },
    {
      key: "cashier",
      name: "Cashier",
      system: false,
      permissions: {
        dashboard: ["view"],
        pos: ["view", "create", "discount"],
        products: ["view"],
        inventory: ["view"],
        invoices: ["view"],
        returns: ["view", "create"],
        barcodes: ["view"],
        cashClosing: ["create"],
        warranty: ["view", "create"],
      },
    },
    // Sales rep: signs in to work with their own orders only
    { key: "sr", name: "Sales Rep (SR)", system: false, permissions: { myOrders: ["view", "create", "cancel"] } },
  ];
};

/**
 * Can this role do `action` on `page` under the store's plan?
 * The Admin (system) role can do everything the plan opens.
 */
const roleCan = (role, subscription, page, action = "view") => {
  if (!role) return false;
  if (!(MODULE_PAGES[subscription] || MODULE_PAGES.both).includes(page)) return false;
  if (role.system) return true;
  return ((role.permissions || {})[page] || []).includes(action);
};

/** Keep only known pages / actions in a permissions object sent by the client. */
const cleanPermissions = (perms) => {
  const out = {};
  PAGES.forEach((p) => {
    const list = Array.isArray(perms?.[p.key]) ? perms[p.key].filter((a) => p.actions.includes(a)) : [];
    if (list.length) out[p.key] = [...new Set(list)];
  });
  return out;
};

module.exports = { PAGES, MODULE_PAGES, fullPermissions, defaultRoles, roleCan, cleanPermissions };
