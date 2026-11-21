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

module.exports = { ADJUSTMENT_TYPES, CASH };
