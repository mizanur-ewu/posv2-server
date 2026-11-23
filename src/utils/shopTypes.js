/**
 * Kinds of shop the app is made for. The client has the same keys (src/shopTypes.js) with the labels,
 * the words it uses for "category" / "brand" and the setup suggestions.
 * `options` are the shop options a new shop of that kind starts with.
 */
const SHOP_TYPES = {
  mobile: { useSerials: true },
  gadget: { useSerials: true },
  computer: { useSerials: true },
  electronics: { useSerials: true },
  electrical: {},
  clothing: { useVariants: true },
  footwear: { useVariants: true },
  bags: {},
  kids: { useVariants: true },
  sports: { useVariants: true },
  cosmetics: {},
  stationery: {},
  bookshop: {},
  toys: {},
  auto: {},
  pet: {},
  agro: {},
  pharmacy: {},
  furniture: {},
  other: {},
};

const isShopType = (k) => Object.prototype.hasOwnProperty.call(SHOP_TYPES, k);

/** Options a new shop of this kind starts with. */
const typeOptions = (k) => ({ useVariants: !!SHOP_TYPES[k]?.useVariants, useSerials: !!SHOP_TYPES[k]?.useSerials });

/** Trimmed text or null, cut to `max` characters. */
const cleanText = (v, max = 60) => {
  const s = String(v ?? "").trim().replace(/\s+/g, " ");
  return s ? s.slice(0, max) : null;
};

module.exports = { SHOP_TYPES, isShopType, typeOptions, cleanText };
