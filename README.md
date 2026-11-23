# POS & Dealer API

Express + Prisma (PostgreSQL) backend for `pos-and-dealer-client`. Structure follows stock-manager-server-v2:
`src/routes` → `src/controllers` → shared logic in `src/utils`.

## Run

```bash
npm install
npx prisma generate      # npm 11 skips Prisma's install scripts – this fetches the engine
npx prisma db push       # create / update tables (schema "pos_dealer", see .env)
npm run seed             # store DHK, payment methods, roles, demo users (password: demo1234)
npm run dev              # http://localhost:4000
```

Frontend: `cd ../pos-and-dealer-client && npm run dev` – the browser calls the API directly at
`VITE_API_URL` in the client's `.env` (e.g. `http://localhost:4001/api/v1`; it must match `PORT` here).

## Database

`DATABASE_URL` points at the `posdb` database, which belongs to this app alone (tables in the default
`public` schema). `npx prisma db push` creates / updates the tables, `npm run seed` adds the plans,
platform settings, the platform owner and the demo shop (safe to run again).

## SaaS: platform and shops

- **Shops** – one `Company` + `Store` per customer business. Everything a shop owns carries its `storeId`.
- **Platform people** (`PlatformUser`, role `owner` or `support`) sign in on the same login page with their
  email and get the **admin console** (`/admin` in the client). The seed creates `platform@demo.com`
  (password = `DEMO_PASSWORD`); in production create a real owner under Team and switch the demo one off.
- **Plans** (`Plan`) – price per month / year, modules (`pos` / `dealer` / `both` → which pages the shop
  gets) and a user limit. A shop's `subscription` follows its plan.
- **Billing state** (`src/utils/platform.js` `billingOf`) from `Store.trialEndsAt` / `paidUntil`:
  `trial` → `active` (paid) → `grace` (ended, still works `graceDays`) → `expired` (read-only: GET only,
  answered with 402 otherwise). No dates = never expires. `suspended` shops cannot sign in.
- **Payments** are recorded by the platform (`SubscriptionPayment`); recording one moves `paidUntil`.
- **Open shop** – the platform gets a 4-hour admin token for the shop (marked `imp`), works even when the
  shop is suspended or read-only; every such action is written to `PlatformAudit`.
- **Self sign-up** (`POST /auth/signup`, can be switched off in Settings) opens a shop on a free trial with
  starter units and expense categories.

## Shop options, SMS and day close

- **Shop category, zilla, thana** (`Store.shopType`, `district`, `thana`): asked on sign-up and in the admin
  console's New shop (all three needed). Keys live in `src/utils/shopTypes.js` (same keys as the client's
  `src/shopTypes.js`, which holds the labels, the words a kind uses instead of Category / Brand / Product,
  e.g. pharmacy → Generic / Company / Medicine, and the setup suggestions). A kind sets the starting shop
  options (mobile → IMEI on, clothing → variants on). Zilla / thana are saved in English; the client's
  `src/data/bdGeo.js` gives the Bangla names.
- **Setup assistant** (`Store.setupPending`, `/settings/setup`, `/settings/setup/skip`): a new shop's admin
  lands on `/setup` and gets, step by step, units, categories, brands, expense categories, suppliers and
  sample products for its kind, all editable before saving. Names that already exist are reused, never
  doubled, so it can be opened again from Settings → Shop details. Skipping adds the starter units and
  expense categories if the shop has none.
- **Variants** (shop option `useVariants`): a product with `hasVariants` is a template; each variant is a
  Product of its own (`parentId`, `variantName`, own barcode / prices / stock), so the stock engine is
  unchanged. Names show as "T-Shirt (Red / XL)" (`L.fullName`). The parent itself can't get stock.
- **IMEI / serial** (shop option `useSerials`, product `trackSerial`): `SerialNumber` is the unit register.
  Stock entry lines, POS lines, customer returns and stock-out adjustments of such a product carry
  `serials`; count gains add them. Costing stays FIFO by lot. Sales outs / orders refuse IMEI products.
  `warrantyMonths` sets `warrantyUntil` on sale. Warranty lookup and claims: `/warranty/*`.
- **SMS** (`src/services/sms`): `provider.js` is the BulkSMSBD gateway (`SMS_API_KEY`, `SMS_SENDER_ID`);
  `sms.js` queues every message in `SmsLog`, a worker sends every 8 s with 3 tries, and messages are
  claimed so two server processes never send the same one. Test mode until `PlatformSetting.smsLive`.
  Shop messages (sale, payment, due reminder, daily summary 21:30) cost 1 credit per SMS part
  (`Store.smsBalance`, topped up by the platform); OTP, expiry reminders (10:00) and tests are free.
- **Forgot password**: `POST /auth/forgot` sends a 6-digit code (hashed, 10 min, 5 tries), `POST /auth/reset`.
- **Day close** (`/cash/closing*`): per cashier per day, from `src/utils/money.js` (every money movement:
  sale payments, due collections, SR deposits, staff payments in; refunds, expenses, supplier payments out).
  **Cash book**: `/cash/book` with opening balance and running balance.
- **Customer returns** refund each item's share of what was paid (bill discount off, VAT in).

## How it works

- **Tenancy** – every business table has `storeId` + `companyId`; the JWT carries the user, every query is
  scoped by `req.storeId`.
- **Permissions** – roles hold `{ page: [actions] }`. Routes use `authorizePermission("stock:create")`;
  the store's plan (pos / dealer / both) must also open the page. Admin (system role) can do everything.
- **Stock engine** (`src/utils/stock`) – every stock entry line is a lot; a SKU is product + selling price.
  Sales, sales outs, adjustments and discounts pick lots FEFO → FIFO, cost is the exact lot purchase price.
  `StockWork` loads a SKU with all its lots, changes them in memory and `flush()` writes the changed rows
  and the SKU cache in the same transaction. Every write holds a per-store advisory lock.
- **Dates** – date-only columns are `date / expiryDate / startDate / endDate` and come back as `YYYY-MM-DD`;
  money / quantity Decimals come back as numbers. The server runs in `TZ` (Asia/Dhaka).
- **Discounts** end by themselves: a daily cron (00:01) plus a check before stock lists.

## API (all under `/api/v1`, responses are `{ status, message, data }`)

| Area | Routes |
|---|---|
| auth | `POST /auth/login` `{identifier, password}` → `{ kind: 'shop' \| 'platform', user, accessToken }` · `POST /auth/signup` · `GET /auth/public` · `POST /auth/logout` · `POST /auth/changePassword` · `GET /auth/demoAccounts` (login page quick fill, not in production) |
| platform (admin console, platform token) | `GET /platform/me` · `POST /platform/me/password` · `GET /platform/overview` · `GET/POST /platform/shops` · `GET/PATCH /platform/shops/:id` · `PATCH /platform/shops/:id/dates` · `POST /platform/shops/:id/{suspend,activate,open}` · `POST /platform/shops/:id/users/:userId/password` · `PATCH /platform/shops/:id/users/:userId` · `DELETE /platform/shops/:id` `{confirm: code}` · `GET/POST /platform/plans` · `PATCH/DELETE /platform/plans/:id` · `GET/POST /platform/payments` · `DELETE /platform/payments/:id` · `GET/POST /platform/announcements` · `PATCH/DELETE /platform/announcements/:id` · `GET/POST /platform/team` · `PATCH /platform/team/:id` · `GET /platform/audit` · `GET/PATCH /platform/settings` (owner-only: plans, settings, team, announcements, deleting shops and payments) |
| settings | `GET /settings/meta` (also billing, announcements, support contact) · `PATCH /settings/store` · `GET /settings/billing` · `POST/PATCH/DELETE /settings/role[/:id]` · `POST/PATCH /settings/user[/:id]` · `POST /settings/clearData` · `GET /settings/notifications` |
| products | `GET/POST /product` · `PATCH /product/:id` · `GET/POST /product/master/:kind` · `PATCH/DELETE /product/master/:kind/:id` |
| stock | `GET/POST /stock` · `GET/PATCH/DELETE /stock/:id` · `POST /stock/checkPriceConflicts` · `GET /stock/sku` · `GET /stock/sku/:id/lots` · `GET /stock/lookup?code=` |
| adjustment | `GET/POST /adjustment` · `PATCH/DELETE /adjustment/:id` · `POST /adjustment/stockEntry` |
| discount | `GET/POST /discount` · `PATCH /discount/:id` · `POST /discount/:id/end` |
| supplier | `POST /supplier` · `PATCH /supplier/:id` · `GET/POST /supplier/payments` · `GET /supplier/dues` |
| expense | `GET/POST /expense[/category]` · `GET/PATCH/DELETE /expense/:id` · `PATCH/DELETE /expense/category/:id` |
| invoice | `GET /invoice` · `GET /invoice/:id` · `GET /invoice/byNo/:no` · `POST /invoice/pos` · `POST /invoice/:id/payment` · `DELETE /invoice/:id` |
| returns | `GET/POST /salesReturn` |
| due | `GET /due` · `GET /due/collections` · `GET /due/staffParties` · `POST /due/staff` · `DELETE /due/staff/:id` · `POST /due/collect` |
| customers | `GET/POST /customer` · `PATCH /customer/:id` · `POST/PATCH /customer/area[/:id]` · `POST/PATCH /customer/route[/:id]` |
| employees | `GET/POST /employee` · `PATCH /employee/:id` |
| orders | `GET/POST /salesOrder` · `PATCH/DELETE /salesOrder/:id` · `POST /salesOrder/:id/cancel` · `POST /salesOrder/:id/deliver` |
| sales out | `GET/POST /productIssue` · `GET/DELETE /productIssue/:id` · `POST /productIssue/:id/cancel` · `POST /productIssue/:id/settle` · `GET /productIssue/:id/settlementDraft` · `PATCH/DELETE /productIssue/:id/settlement` |
| dashboard / reports | `GET /dashboard` · `GET /report/{sales,stock,profit,employee,settlement,expiry,due}` · `GET /report/{customerStatement,supplierLedger,stockMovement,salesBy,deadStock,purchases,vat}` (`?from=&to=`) |
| cash | `GET /cash/closing/day?date=&userId=` · `POST /cash/closing` · `GET /cash/closing` · `DELETE /cash/closing/:id` · `GET /cash/book?from=&to=&methodId=` |
| warranty / IMEI | `GET /warranty/lookup?q=` · `GET /warranty/serials` · `GET /warranty/available?productId=` · `GET /warranty/sold/:invoiceId` · `GET/POST /warranty/claims` · `PATCH /warranty/claims/:id` |
| SMS | shop: `GET/PATCH /settings/sms` · `GET /settings/sms/log` · `POST /settings/sms/test` · `POST /due/remind` · platform: `GET/PATCH /platform/sms` · `POST /platform/sms/test` · `POST /platform/shops/:id/sms-credits` |
