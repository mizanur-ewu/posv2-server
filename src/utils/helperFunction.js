const dayjs = require("dayjs");

/** Round to 2 decimals (money). */
const r2 = (n) => Math.round((Number(n) || 0) * 100) / 100;

/** Round to 3 decimals (quantity). */
const r3 = (n) => Math.round((Number(n) || 0) * 1000) / 1000;

/** Business date "YYYY-MM-DD" (server runs in the store time zone, see TZ in .env). */
const ymd = (d) => dayjs(d || undefined).format("YYYY-MM-DD");

/** Today as "YYYY-MM-DD". */
const today = () => dayjs().format("YYYY-MM-DD");

/** Value for a @db.Date column: the business date at UTC midnight (null stays null). */
const toDate = (d) => (d ? new Date(`${ymd(d)}T00:00:00.000Z`) : null);

/** Value for a DateTime column (defaults to now). */
const toDateTime = (d) => (d ? dayjs(d).toDate() : new Date());

/** True when the date falls inside [from, to] (whole days). */
const inRange = (d, [from, to]) =>
  !dayjs(d).isBefore(dayjs(from).startOf("day")) &&
  !dayjs(d).isAfter(dayjs(to).endOf("day"));

/** Phone numbers compare by digits only; +880 / 880 prefixes match the local 01… form. */
const normPhone = (p) => {
  const d = String(p || "").replace(/\D/g, "");
  return d.length === 13 && d.startsWith("880") ? d.slice(2) : d;
};

const normEmail = (e) => String(e || "").trim().toLowerCase();

/** Map of id → row. */
const indexBy = (list, key = "id") => new Map(list.map((x) => [x[key], x]));

/** Sum of fn(row) over a list. */
const sumBy = (list, fn) => list.reduce((a, x) => a + (Number(fn(x)) || 0), 0);

/** storeId + companyId of the signed-in user – spread into every create. */
const tenant = (req) => ({ storeId: req.storeId, companyId: req.companyId });

/** Context the stock engine needs: tenant, store code (document numbers) and the acting user. */
const ctxOf = (req) => ({
  storeId: req.storeId,
  companyId: req.companyId,
  storeCode: req.storeCode,
  userId: req.user?.id,
});

/** Query string list: "a,b" or ["a","b"] → ["a","b"] (empty → null). */
const listParam = (v) => {
  if (v === undefined || v === null || v === "") return null;
  const arr = Array.isArray(v) ? v : String(v).split(",");
  const clean = arr.map((x) => String(x).trim()).filter(Boolean);
  return clean.length ? clean : null;
};

const boolParam = (v) => v === true || v === "true" || v === "1";

module.exports = {
  r2,
  r3,
  ymd,
  today,
  toDate,
  toDateTime,
  inRange,
  normPhone,
  normEmail,
  indexBy,
  sumBy,
  tenant,
  ctxOf,
  listParam,
  boolParam,
};
