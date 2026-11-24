/** Stock return & adjustment types. "shortage" is created by a sales return (settlement) only. */
const ADJUSTMENT_TYPES = {
  supplier_return: { label: "Return to supplier", direction: "out" },
  damage: { label: "Damaged", direction: "out" },
  expired: { label: "Expired", direction: "out" },
  lost: { label: "Lost / missing", direction: "out" },
  count_gain: { label: "Count gain (found)", direction: "in" },
  shortage: { label: "SR / delivery shortage", direction: "out" },
};

/** Default payment method when none is given (global payment method ids). */
const CASH = "pm_cash";

/**
 * Every payment method (one global list, the same ids in every shop). Written to the table at
 * start-up, so a new method shows up everywhere without a manual seed. Ids never change: payments
 * point at them. pm_mfs was "Mobile Banking" before bKash / Nagad / Rocket got their own.
 */
const PAYMENT_METHODS = [
  { id: "pm_cash", name: "Cash", sortOrder: 1 },
  { id: "pm_bkash", name: "bKash", sortOrder: 2 },
  { id: "pm_nagad", name: "Nagad", sortOrder: 3 },
  { id: "pm_rocket", name: "Rocket", sortOrder: 4 },
  { id: "pm_card", name: "Card", sortOrder: 5 },
  { id: "pm_mfs", name: "Other mobile banking", sortOrder: 6 },
  { id: "pm_bank", name: "Bank Transfer", sortOrder: 7 },
];
/** What a shop takes at POS until the owner picks (Store.payMethodIds empty). */
const DEFAULT_SHOP_METHODS = ["pm_cash", "pm_bkash", "pm_nagad", "pm_card"];
/** The shop's POS payment methods, cash always first. */
const shopMethodIds = (store) => {
  const known = new Set(PAYMENT_METHODS.map((m) => m.id));
  const picked = (store?.payMethodIds?.length ? store.payMethodIds : DEFAULT_SHOP_METHODS).filter((id) => known.has(id) && id !== CASH);
  return [CASH, ...PAYMENT_METHODS.map((m) => m.id).filter((id) => picked.includes(id))];
};

/** Payment method ids sent by the owner → the list to save (known ids, cash always in). */
const cleanMethodIds = (list) => shopMethodIds({ payMethodIds: [...new Set((Array.isArray(list) ? list : []).map(String)), CASH] });

module.exports = { ADJUSTMENT_TYPES, CASH, PAYMENT_METHODS, DEFAULT_SHOP_METHODS, shopMethodIds, cleanMethodIds };
