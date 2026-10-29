# API reference

REST API for the GiftCraft platform. Base path: `/api/v1`, set by `API_VERSION`. The web app reaches it through the Next.js rewrite, so in the browser it is same-origin at `http://localhost:3000/api/v1`. Direct calls go to `http://localhost:4000/api/v1`.

`GET /api/v1/health` returns `{ status: true, data: { env } }` and needs no session.

## Conventions

**Response envelope.** Every response uses the same shape:

```json
{ "status": true, "message": "OK", "data": { }, "meta": { "page": 1, "limit": 20, "total": 57, "totalPages": 3 } }
```

`meta` is present on paginated lists only. Lists accept `?page=` and `?limit=` (maximum 100).

**Errors.** An error looks like this:

```json
{ "status": false, "message": "Human-readable reason", "code": "MACHINE_CODE", "details": [ ] }
```

| HTTP | Meaning |
|---|---|
| 400 | Malformed JSON (`BAD_JSON`) or invalid data |
| 401 | No or expired session (`UNAUTHORIZED`, `TOKEN_EXPIRED`, `TOKEN_INVALID`, `SESSION_REVOKED`, `REFRESH_INVALID`), or a bad webhook signature |
| 403 | Missing permission, wrong company or vendor, or a CSRF failure (`CSRF_FAILED`) |
| 404 | Not found, or not visible to the caller (records you don't own are hidden as 404) |
| 409 | Conflict: an invalid state transition, a duplicate record, or a locked proof |
| 413 | Upload is larger than `UPLOAD_MAX_MB` |
| 422 | Validation failed (`VALIDATION_FAILED`, with per-field `details`), or a business rule failed (e.g. below the MOQ, out of stock, or over the approval limit) |
| 429 | Rate limited. The response carries a `Retry-After` header |

Stack traces and SQL are never returned. In non-production environments, database errors add a `debug` string.

**Money.** All amounts are integer paise. Fields end in `_paise` or `Paise`, so ₹1,234.50 is `123450`.

**Sessions.** Sign-in sets these cookies:

| Cookie | HTTP-only | Purpose |
|---|---|---|
| `access_token` | yes | 15-minute JWT |
| `refresh_token` | yes | Rotating, 30-day token. Path `/api/v1/auth`. Stored hashed |
| `signed_in` | no | Hint that holds no secret; the web proxy uses it to route |
| `csrf_token` | no | Double-submit token |

`POST /auth/refresh` issues a new access token and a new refresh token on every call; the previous refresh token stops working. Signing out or resetting the password revokes the session(s).

**CSRF.** Every non-GET request except `/webhooks/*` must send an `X-CSRF-Token` header equal to the `csrf_token` cookie. `GET /auth/csrf` issues the cookie.

**Access control.** Every check happens on the server. The table columns below mean:

| Term | Meaning |
|---|---|
| signed in | Valid access token required |
| company member | Active member of the buyer's company |
| vendor member / approved vendor | Linked to a vendor account; "approved" also requires the vendor to have passed review |
| `perm.name` | Role permission. `a / b` means either one is enough |

Order, proof, design, ticket and quote endpoints marked only "signed in" check ownership in the service layer. Customers see their own records. Company members see their company's records, limited by member role. Staff see records according to their permissions.

## Two-step sign-in (email OTP)

1. **Start.** `POST /auth/register` or `POST /auth/login` returns a challenge, not a session:

   ```json
   { "challengeId": "uuid", "purpose": "login", "destination": "pr***@demo.test",
     "expiresAt": "...", "resendAvailableAt": "...", "emailDelivery": false, "devOtp": "123456" }
   ```

   `devOtp` is present only when `SHOW_DEV_OTP=true` and `APP_ENV` is not `production`.
2. **Verify.** `POST /auth/verify-otp` with `{ challengeId, otp }` creates the session and sets the cookies. Codes are HMAC-hashed at rest, expire after `OTP_TTL_MINUTES`, allow `OTP_MAX_ATTEMPTS` tries, and are single-use. A new code invalidates the previous one.
3. **Resend.** `POST /auth/resend-otp` with `{ challengeId }` is allowed after `OTP_RESEND_COOLDOWN_SECONDS`, and at most `OTP_MAX_RESENDS` times.

Password reset uses the same shape: `forgot-password` → `forgot-password/verify` (returns a one-time reset token) → `reset-password`. A reset revokes all sessions.

Auth endpoints are rate limited per IP and also per email or challenge.

## Payments

`POST /orders/:id/payments` creates a gateway order for the amount currently due: the full amount, the 50% advance, or the balance.

| Provider | How payment completes |
|---|---|
| `razorpay` | The client opens Razorpay Checkout, then calls `POST /payments/verify` with the signature. `POST /webhooks/razorpay` (verified with `RAZORPAY_WEBHOOK_SECRET`, idempotent per event id) settles payments even if the browser never returns |
| `mock` (development only) | `POST /payments/:id/mock-complete` with `{ outcome: "success" \| "failure" }` follows the same server path. The server refuses to start with mock payments when `APP_ENV=production` |

Order totals, prices, GST and coupons are always recalculated on the server. The client never supplies a price.

## Quotation to delivery flow

An accepted quotation follows seven stages. `GET /quotes/:id` and `GET /orders/:id` (and `/admin/orders/:id`) return the same `flow` object, derived from the workflow records:

| # | Stage (`key`) | Statuses (`label`) | Moved on by |
|---|---|---|---|
| 1 | Quotation approval (`quotation`) | Awaiting approval · Under review · Returned for correction · Sent to customer | staff price and send a version (`POST /quotes/:id/versions`) |
| 2 | Customer review (`response`) | Awaiting response · Revision requested · Accepted · Rejected · Expired | customer `accept` / `request-revision` / `reject` |
| 3 | Order confirmation (`order`) | Pending confirmation · Confirmed · Cancelled | acceptance creates the sales order with `status: pending_confirmation`; staff `POST /admin/orders/:id/confirm` or `/cancel` |
| 4 | Payment (`payment`) | Pending · Partially paid · Paid · Failed · Credit terms | advance / full payment as agreed (`POST /orders/:id/payments`, offline payments). No payment is accepted before confirmation (`409 CONFIRMATION_PENDING`) |
| 5 | Artwork & production (`production`) | Artwork pending · Artwork approved · In production · Quality check | proofs, proof approval, production assignment and milestones, QC |
| 6 | Dispatch (`shipping`) | Ready to dispatch · Dispatched · Delivered | shipments and tracking; balance is due before dispatch |
| 7 | Delivery, invoice & closure (`final`) | Awaiting closure · Completed | staff `POST /admin/orders/:id/close` once every line is delivered and paid (credit accounts excepted): the final GST invoice is issued and the order completes. Delivered lines still close automatically when the complaint window ends |

Each stage has `state`: `done`, `current`, `upcoming`, `blocked` (rejected, expired or cancelled; later stages become `skipped`) or `skipped` (stages 1-2 for orders placed through checkout). `flow.current` is the stage waiting for action and `flow.completed` is true once the order is closed.

Orders carry `confirmation_status` (`not_required` for checkout orders, `pending`, `confirmed`, `cancelled`), `confirmed_at` and `confirmation_note`. Order detail `actions` add `canConfirm`, `canClose` and, for staff, `closeBlocker` (why the order cannot be closed yet).

## Order listing filters

`GET /orders` and `GET /admin/orders` take `module` + `status`. Each status belongs to one module (defined once in `src/Services/orderFilters.js`); a status from another module is refused with `422 INVALID_FILTER`. Without `module`, `status` is the order status (comma-separated values allowed), as before.

| `module` | Filters on | Statuses |
|---|---|---|
| `order` | the order's status | `pending_confirmation`, `awaiting_approval`, `payment_pending`, `confirmed`, `in_progress`, `partially_shipped`, `shipped`, `delivered`, `completed`, `cancelled`, `refunded` |
| `payment` | the payment status | `pending`, `partially_paid`, `paid`, `failed` (nothing paid and the latest attempt failed), `credit`, `partially_refunded`, `refunded` |
| `production` | orders with any line in | `artwork_pending` (artwork pending / proof sent), `artwork_approved` (ready to assign), `assigned`, `in_production`, `quality_check` (incl. failed QC), `on_hold` |
| `shipping` | orders with any line in | `ready_to_dispatch` (packed), `dispatched`, `returned` (RTO), `delivered` (delivered or closed) |

`GET /orders/filter-options?scope=mine|company` and `GET /admin/orders/filter-options` (`orders.view`) return every module with its statuses, labels and the number of orders the caller can see in each.

## Tax master (GST rates and HSN/SAC codes)

Platform admins (`settings.manage`) manage GST from **Settings → Taxes**.
- **How products use it:** products link to a rate (`products.tax_rate_id`), and `products.gst_rate` is kept in sync with it, so pricing, cart, quotes and invoices read the rate unchanged.
- **History:** order, quote and invoice lines store their own copy of the HSN code and rate at checkout, so editing the master never alters past documents.

| Method | Path | Purpose |
|---|---|---|
| GET | `/admin/tax/rates` | All rates with usage counts: `products`, `hsnCodes`, `categories` |
| POST | `/admin/tax/rates` | `{ name, rate, description? }`. Names are unique, and only one active rate may exist per percentage. Up to two decimals, from 0 to 100 |
| PUT | `/admin/tax/rates/:id` | Same body. Changing `rate` re-prices every product linked to it; the response includes `productsUpdated` |
| POST | `/admin/tax/rates/:id/active` | `{ active }`. A rate still used by products, active HSN codes or category defaults can't be deactivated (409 `TAX_RATE_IN_USE`) |
| GET | `/admin/tax/hsn` | Query parameters: `q` (code prefix or description), `taxRateId`, `status` (`active` / `inactive`), `page` |
| POST | `/admin/tax/hsn` | `{ code, kind: "HSN" \| "SAC", description, taxRateId }`. The code is 4, 6 or 8 digits and unique |
| PUT | `/admin/tax/hsn/:id` | `{ kind, description, taxRateId, applyToProducts? }`. The code can't be renamed. `applyToProducts: true` also moves every product with this code to the new rate |
| POST | `/admin/tax/hsn/:id/active` | `{ active }` |
| GET | `/catalog/tax-options` | Public. Active rates and HSN/SAC codes for product, listing and category forms |

**How a product's rate is decided**, when an admin saves a product or a vendor saves a listing:
1. `taxRateId`, if given. It must be active, unless it's the product's current rate.
2. Otherwise `gstRate` (a percentage, for older clients), matched to an active rate. A percentage that isn't in the master is refused.
3. Otherwise the active HSN/SAC mapping for `hsnCode`.
4. Otherwise the category's `defaultTaxRateId`.
5. Otherwise 422 `TAX_RATE_REQUIRED`.

Categories accept `defaultTaxRateId` (an active rate, or `null`).

## Organisation user management

Each organisation administrator manages users of **their own organisation only**. The organisation is taken from the admin's session and is never read from the request. Users of another organisation do not exist as far as the API is concerned: requests for them return 404.

| Scope | Base path | Who (permission) | Roles they can create |
|---|---|---|---|
| Company | `/business/users` | Business Admin (`company.team.manage`) | Business Approver, Business Buyer |
| Vendor | `/vendor/users` | Vendor Admin of an approved vendor (`vendor.team.manage`) | Vendor Staff |
| Platform | `/admin/platform-users` | Platform Admin (`roles.manage`) | Support Agent, Production Staff |

Admin accounts (Business Admin, Vendor Admin, Platform Admin) and the signed-in admin's own account appear in the lists but cannot be changed through these endpoints.

| Method | Path (after the base) | Purpose |
|---|---|---|
| GET | `` | List members. Query parameters: `q` (name or email), `role` (role code), `status` (`active` / `invited` / `inactive`), `page`, `limit`. Each user includes their latest invitation email status |
| GET | `/export` | The same list as a CSV download (same filters) |
| POST | `/validate` | `{ rows }`. Validates rows without saving. Returns each row with its normalised data and per-field `errors`, plus `summary { total, valid, invalid }` |
| POST | `/bulk` | `{ rows, idempotencyKey, source: "manual" \| "csv" }`. Creates every valid row; invalid rows come back as `failed` with their errors. Response: `{ batchId, total, created, failed, emails, results[] }`. Repeating the same `idempotencyKey` returns the original result (`replayed: true`) and creates nothing |
| GET | `/batches/:batchId` | A batch result, with live email delivery status per created user |
| PATCH | `/:id` | `{ name?, phone?, role? }`. The role must be one this admin can assign |
| POST | `/:id/status` | `{ active: boolean }`. Deactivating signs the user out everywhere and blocks sign-in. Only the level that deactivated an account can reactivate it; a platform suspension can only be lifted by the platform |
| POST | `/:id/resend-invite` | Queues a new invitation email. Older links stop working. Rate-limited: one per minute unless the previous email failed |

**Row fields** (manual form or CSV columns):

| Field | CSV header | Required | Notes |
|---|---|---|---|
| `name` | Full Name | yes | |
| `email` | Email Address | yes | Must be unique across the whole system |
| `phone` | Phone Number | no | 10-digit Indian mobile number |
| `role` | Role | yes | Code, label or short name, e.g. `business_buyer`, `Business Buyer` or `buyer` |
| `sendInvite` | Send Invite in Email | no | Yes or No; defaults to Yes |
| `organization` | Company / Vendor / Organization | no | If given, must match the admin's own organisation, otherwise the row fails |

At most 500 rows per request.

**Accounts and passwords**
- **Production:** new accounts are `invited` and have no usable password. The invitation email carries a single-use set-password link, valid for `INVITE_TTL_HOURS` (default 72). Only an HMAC of the link token is stored, and sending a new invitation replaces it.
- **Development:** with `DEV_DEFAULT_PASSWORD` set (for example `Auth@1234`; refused when `APP_ENV=production`), accounts start `active` with that password, stored hashed. They must change it at first sign-in.
- **Forced change:** until the password is changed, the API answers every request except `GET /auth/me`, `POST /auth/change-password` and `POST /auth/logout` with `403 PASSWORD_CHANGE_REQUIRED`.
- **Password in the email:** with `DEV_EMAIL_DEFAULT_PASSWORD=true`, the welcome email also includes the password. It's added when the email is sent and is never stored in the outbox.

**Invitation endpoints** (public, rate-limited):

| Method | Path | Body | Result |
|---|---|---|---|
| POST | `/auth/invitations/preview` | `{ token }` | `{ name, email, role, organisation, expiresAt }` |
| POST | `/auth/invitations/accept` | `{ token, password, confirmPassword }` | Sets the password, activates the account and consumes the link. The user then signs in normally (password + email code) |

**Email delivery** goes through a durable outbox (`email_outbox`):
- **Queueing:** messages are queued in the same transaction as the account, so nothing is emailed for work that's rolled back. A worker in the API process delivers them every 30 seconds.
- **Retries:** a failed send is retried after 1, 5, 15 and 60 minutes, up to 5 attempts.
- **Statuses:** `queued`, `sending`, `sent`, `failed`, or `logged`. `logged` means `MAIL_DRIVER=log` wrote the email to the console instead of sending it.
- **No duplicates:** each email has a unique dedupe key per batch row, so a retried bulk request never sends twice.

## Blog

Platform admins hold every `blog.*` permission through their role. Other platform users (support agents, production staff) get blog permissions **individually**: the Platform Admin grants them under Blog → Permissions, and they are stored in `user_permissions`. A user's effective permissions are their roles' permissions plus these grants. Grants only count for accounts with a platform role. They take effect on the user's next request.

| Permission | Allows |
|---|---|
| `blog.view` | See every post in the dashboard (without it, users see only posts they authored or created) |
| `blog.create` | Create posts (always saved as drafts) |
| `blog.edit_own` / `blog.edit_all` | Edit own posts / any post; `edit_all` can also change the author |
| `blog.delete_own` / `blog.delete_all` | Delete own posts / any post |
| `blog.publish` / `blog.unpublish` / `blog.schedule` | Publish now / unpublish or archive / schedule posts they can edit |
| `blog.feature` | Mark posts as featured |
| `blog.taxonomy.manage` | Manage categories and tags (and create new tags while writing) |
| `blog.analytics.view` | Blog statistics |
| `blog.approve` | Approve or reject submitted posts (role only, not grantable) |
| `blog.permissions.manage` | Assign blog permissions and the approval setting (role only, not grantable) |

Presets offered in the UI: **Viewer** (`view`), **Contributor** (`view, create, edit_own, delete_own`), **Author** (Contributor plus `publish, unpublish, schedule`) and **Editor** (every grantable permission).

**Workflow.** Statuses: `draft`, `pending_approval`, `approved`, `published`, `scheduled`, `rejected`, `archived`. Actions go to `POST /admin/blog/posts/:id/:action`:

- `submit`
- `approve` (optional `note`)
- `reject` (`note` required)
- `publish`
- `schedule` (`scheduledAt`, ISO time at least a minute ahead)
- `unpublish`
- `archive`
- `restore`
- `feature` (`{ featured: boolean }`)

The approval setting (`settings.blog.approval_required`, on by default) controls publishing. While it is on, users without `blog.approve` can publish or schedule only `approved` posts. They also cannot edit a live post, and an edit to an approved post returns it to `draft`.

Every post response carries `actions`: a map of what the current user may do with that post. It is computed by the same rules the API enforces. A missing permission returns 403. A wrong status returns 409, with `BLOG_APPROVAL_REQUIRED`, `BLOG_LIVE_LOCKED` or `BLOG_INVALID_STATE`.

**Scheduling.** A background job publishes due posts every minute. Public queries also treat `scheduled` posts whose time has passed as live, so they appear on time even if the job lags.

**Content.** Post HTML is passed through an allow-list sanitiser on save and again when served. Allowed: headings, paragraphs, emphasis, lists, links, blockquotes, tables, images and code. Removed: scripts, event handlers, styles, iframes and `javascript:`/`data:` URLs. Images must be `/api/v1/assets/<id>` (upload with `POST /uploads?kind=blog_image`: PNG, JPG or WebP up to 5 MB, served publicly) or `https://` URLs. Slugs are unique. If a slug is left out, it is generated from the title with a `-2`, `-3` suffix when needed. An explicit slug that is taken returns 409 `SLUG_TAKEN` with a `suggestion`.

**Public API.** It returns live posts only: unpublished and unknown slugs both return 404. Author emails are never included. `GET /blog/posts/:slug?view=1` also counts a page view.

## Visiting cards

A separate module for designing and bulk-ordering visiting cards. It has its own tables (`vc_*`), orders, payments, invoices and receipts. It reuses the platform's payment gateway adapters, GST calculation, seller details, uploads, notifications and audit log.

**Who can do what**

| Permission | Allows |
|---|---|
| `shop.purchase` | Every `/visiting-cards/*` endpoint (customers and business users; platform staff get 403) |
| `company.brand.manage` | Corporate designs and orders for the user's company, the team directory and spreadsheet import |
| `vc.view` | Admin dashboard, orders, customers and templates (read) |
| `vc.orders.manage` | Artwork approve/reject, status changes, tracking, cancellation |
| `vc.templates.manage` | Templates and categories |
| `vc.pricing.manage` | Price slabs, printing options, module and delivery settings |
| `vc.payments.view` / `vc.payments.manage` | Payment records, invoices and receipts / offline payments and refunds |
| `vc.reports.view` | Reports |

Platform admins hold all of these. Production staff have `vc.view` and `vc.orders.manage`; support agents have `vc.view`. Amounts (prices, totals, payments, revenue) are stripped from responses for staff without `vc.payments.view` or `orders.view`, so production staff never see them.

**Design document.** `{ version: 1, theme, front, back | null }`. Each side has a `background` and up to 40 `elements` (`text`, `image`, `qr`, `shape`) positioned in percent of the card. Text may use `{{field}}` placeholders (`fullName`, `designation`, `department`, `company`, `tagline`, `mobile`, `phone`, `email`, `website`, `address`); unknown placeholders are rejected (422). Colours are hex values or theme tokens (`primary`, `secondary`, `text`, `muted`, `background`). Images point at the design's `fields.logoAssetId` / `fields.photoAssetId`, which must be image uploads the user can access.

**Designs.** `POST /visiting-cards/designs { templateId, customerType }` copies a published template and pre-fills the card details from the account: name, email, mobile and job title (`users.designation`, edited under Profile), plus company and default address. Card details live on the design only and never change the account. Corporate designs belong to the company and hold `employees` rows; blank cells fall back to the company-wide details.

**Employee import.** `POST /visiting-cards/employees/import` (multipart `file`: CSV or `.xlsx`, first sheet) only validates; it stores nothing. It returns every row with `errors` per field: name required, email and phone formats, quantity limits, and repeated emails or employee codes. The browser then saves the valid rows with the design.

**Ordering.** Quantities are cards per person. Every person needs at least `min_qty_per_card` and the order at least `min_order_qty` (both 100 by default, in `settings.visiting_cards`).
- `POST /visiting-cards/quote` returns the server-side price with `canOrder` and `problems`. The unit price is the quantity slab for the order's total, plus the chosen print options, plus the double-sided surcharge. Delivery is charged per box, and GST is CGST + SGST or IGST against the seller's state.
- `POST /visiting-cards/orders` refuses orders with problems (422). It needs an `idempotencyKey`, unique per user, so a repeated request returns the first order with 200 instead of creating a second.
- Orders snapshot the template, design, card details, options and prices.

**Lifecycle.**
1. `pending`: placed, not paid.
2. Payment moves the order to `artwork_review` (`artwork_status: submitted`), or straight to `approved` when `artwork_review_required` is off.
3. `POST /admin/visiting-cards/orders/:id/artwork { decision: approve | reject, reason }` approves (`approved`), or rejects with a required reason. The customer then corrects the artwork with `PUT /visiting-cards/orders/:id/artwork`; sides, card count and quantities are fixed.
4. `POST /admin/visiting-cards/orders/:id/status` moves `approved` → `in_production` → `dispatched` (needs courier and tracking number) → `delivered`.
5. `cancelled`: by the customer only before payment. Staff can cancel before dispatch; `refund: true` refunds captured payments through the gateway (`vc.payments.manage`).

Invalid moves return 409 `INVALID_TRANSITION`.

**Payments.** The same flow as shop orders: `POST /visiting-cards/orders/:id/payments` returns a gateway intent (an open intent is reused), and `POST /visiting-cards/payments/verify` checks the Razorpay signature. The shared `/webhooks/razorpay` endpoint captures visiting card payments too: events are de-duplicated by event id, and gateway order and payment ids are unique in `vc_payments`. Capture locks the payment and order rows and is idempotent. A payment that lands on an already paid or cancelled order is refunded automatically. Full payment issues the GST invoice (shared `INV-` series) and a receipt (`RCT-`).

**Print proofs.** These are rendered in the browser from the order snapshot: every card at actual size with crop marks, printable to PDF, and each side downloadable as a 300 dpi PNG. The API stores no rendered files.

## Endpoints

These tables are generated from `src/Routes/*.js`. Paths are relative to `/api/v1`.

### Authentication & OTP

| Method | Path | Access |
|---|---|---|
| GET | `/auth/csrf` | public |
| POST | `/auth/register` | public |
| POST | `/auth/login` | public |
| POST | `/auth/verify-otp` | public |
| POST | `/auth/resend-otp` | public |
| GET | `/auth/challenges/:challengeId` | public |
| POST | `/auth/forgot-password` | public |
| POST | `/auth/forgot-password/verify` | public |
| POST | `/auth/reset-password` | public |
| POST | `/auth/refresh` | public |
| GET | `/auth/me` | signed in |
| POST | `/auth/logout` | optional session |
| POST | `/auth/change-password` | signed in |

### Catalogue (public)

| Method | Path | Access |
|---|---|---|
| GET | `/catalog/categories` | public |
| GET | `/catalog/categories/:slug` | public |
| GET | `/catalog/methods` | public |
| GET | `/catalog/products` | public |
| GET | `/catalog/products/:slug` | public |
| GET | `/catalog/products/:id/price` | public |
| GET | `/catalog/products/:id/delivery-estimate` | public |

### Customer account

| Method | Path | Access |
|---|---|---|
| GET | `/account/summary` | signed in |
| PUT | `/account/profile` | signed in |
| GET | `/account/addresses` | signed in |
| POST | `/account/addresses` | signed in |
| PUT | `/account/addresses/:id` | signed in |
| DELETE | `/account/addresses/:id` | signed in |
| GET | `/account/wishlist` | signed in |
| POST | `/account/wishlist/:id` | signed in |
| DELETE | `/account/wishlist/:id` | signed in |
| GET | `/account/notifications` | signed in |
| POST | `/account/notifications/read` | signed in |

### Uploads, assets & designs

| Method | Path | Access |
|---|---|---|
| POST | `/uploads` | signed in · multipart field `file` · 200 uploads/hour |
| GET | `/uploads/mine` | signed in |
| GET | `/assets/:id` | optional session |
| GET | `/designs` | signed in · `designs.manage_own` |
| POST | `/designs` | signed in · `designs.manage_own` |
| GET | `/designs/:id` | signed in · `designs.manage_own` |
| DELETE | `/designs/:id` | signed in · `designs.manage_own` |

### Cart, checkout, orders, proofs, payments & reviews

| Method | Path | Access |
|---|---|---|
| GET | `/cart` | signed in · `shop.purchase` |
| POST | `/cart/items` | signed in · `shop.purchase` |
| PATCH | `/cart/items/:id` | signed in · `shop.purchase` |
| DELETE | `/cart/items/:id` | signed in · `shop.purchase` |
| PUT | `/cart/coupon` | signed in · `shop.purchase` |
| POST | `/checkout` | signed in · `shop.purchase` |
| GET | `/orders` | signed in |
| GET | `/orders/:id` | signed in |
| GET | `/orders/:id/timeline` | signed in |
| GET | `/orders/:id/proofs` | signed in |
| GET | `/orders/:id/invoice` | signed in |
| POST | `/orders/:id/cancel` | signed in |
| POST | `/orders/:id/reorder` | signed in · `shop.purchase` |
| POST | `/orders/:id/payments` | signed in · `shop.purchase` |
| POST | `/proofs/:id/approve` | signed in |
| POST | `/proofs/:id/request-changes` | signed in |
| POST | `/payments/verify` | signed in · `shop.purchase` |
| POST | `/payments/:id/mock-complete` | signed in · `shop.purchase` |
| GET | `/products/:id/reviews` | public |
| POST | `/reviews` | signed in · `reviews.write` |

### Quotations (RFQ)

| Method | Path | Access |
|---|---|---|
| POST | `/quotes/recipients/parse` | signed in · `quotes.request` |
| POST | `/quotes` | signed in · `quotes.request` |
| GET | `/quotes` | signed in |
| GET | `/quotes/:id` | signed in |
| POST | `/quotes/:id/accept` | signed in · `quotes.request` |
| POST | `/quotes/:id/request-revision` | signed in · `quotes.request` |
| POST | `/quotes/:id/reject` | signed in · `quotes.request` |
| POST | `/quotes/:id/messages` | signed in |
| POST | `/quotes/:id/repeat` | signed in · `quotes.request` |
| GET | `/quotes/:id/suggestion` | signed in · `quotes.manage` |
| POST | `/quotes/:id/review` | signed in · `quotes.manage` |
| POST | `/quotes/:id/versions` | signed in · `quotes.manage` |
| POST | `/quotes/:id/return` | signed in · `quotes.manage` |
| POST | `/quotes/:id/decline` | signed in · `quotes.manage` |
| POST | `/quotes/:id/resubmit` | signed in · `quotes.request` · requester or company member |
| GET | `/quotes/:id/history` | signed in (anyone who can see the quotation) |
| GET | `/quotes/:id/document?version=N` | signed in (anyone who can see the quotation) |

**Revisions.** Staff can send a request back to the customer for correction, and the customer corrects it and resubmits it:

```
requested | under_review | revision_requested | resubmitted | sent --return--> correction_requested
correction_requested --resubmit (customer)--> resubmitted --review--> under_review --versions--> sent
any open status --decline (staff, reason required)--> rejected
```

- `revision_requested` is the opposite direction: the customer asks staff to re-price a quotation they were sent.
- `return` body: `reason` (5–1000 characters, shown to the customer), `category` (`pricing`, `quantity`, `product`, `artwork`, `customization`, `tax`, `delivery`, `payment_terms`, `other`), optional `instructions` (shown to the customer) and `internalNote` (staff only, never returned to customers). Allowed from the statuses on the left above; otherwise 409 `QUOTE_NOT_RETURNABLE`. While a quotation is `correction_requested` it cannot be priced or accepted.
- `decline` body: `reason` (required), optional `internalNote`. Not allowed once a quotation is accepted, converted, rejected, expired or cancelled (409 `QUOTE_CLOSED`).
- `resubmit` body: `comment` (required) plus any of `title`, `deadline`, `budgetPaise`, `deliveryLocations`, `deliveryPincode`, `notes`, and `items: [{ id, remove?, variantId?, methodId?, quantity?, sizeBreakdown?, printAreaCount?, artworkAssetIds?, notes? }]`. Only lines already on the request can be edited or removed, and at least one must remain. Prices, terms, status and staff notes cannot be changed. Each resubmission increments `quotes.request_revision`; a second resubmission is refused with 409 `QUOTE_NOT_RETURNED`.
- Every step is recorded in `quote_events` (append-only): actor, from/to status, request revision, version number, reason, category, instructions, field changes (`from` / `to`) and a snapshot of the request before each edit. `GET /quotes/:id/history` returns the events and priced versions; `internalNote` is included for staff only.
- `GET /quotes/:id/document` returns the printable quotation for the current version, or an earlier one with `?version=N`. Versions are never modified, so earlier documents reproduce exactly. Tax is the amount stored on the version, split CGST/SGST or IGST by place of supply.
- Customers are notified (in app and by email) when a quotation is returned or rejected; staff with `quotes.manage` are notified in app when it is resubmitted. Staff `return` and `decline` are also written to the admin audit log.

### Business accounts

| Method | Path | Access |
|---|---|---|
| GET | `/business/dashboard` | signed in · company member · `company.view` |
| GET | `/business/company` | signed in · company member · `company.view` |
| PUT | `/business/company` | signed in · company member · `company.view` · `company.manage` |
| GET | `/business/team` | signed in · company member · `company.view` |
| POST | `/business/team` | signed in · company member · `company.view` · `company.team.manage` |
| PATCH | `/business/team/:id` | signed in · company member · `company.view` · `company.team.manage` |
| GET | `/business/brand-kits` | signed in · company member · `company.view` |
| POST | `/business/brand-kits` | signed in · company member · `company.view` · `company.brand.manage` |
| PUT | `/business/brand-kits/:id` | signed in · company member · `company.view` · `company.brand.manage` |
| DELETE | `/business/brand-kits/:id` | signed in · company member · `company.view` · `company.brand.manage` |
| GET | `/business/invoices` | signed in · company member · `company.view` |
| GET | `/business/purchase-orders` | signed in · company member · `company.view` |
| GET | `/business/approvals` | signed in · company member · `company.view` · `company.orders.approve` |
| POST | `/business/approvals/:id` | signed in · company member · `company.view` · `company.orders.approve` |

### Vendor portal

| Method | Path | Access |
|---|---|---|
| GET | `/vendor/me` | signed in |
| POST | `/vendor/application` | signed in |
| PUT | `/vendor/profile` | signed in · vendor member · `vendor.profile.manage` |
| PUT | `/vendor/holidays` | signed in · approved vendor · `vendor.profile.manage` |
| GET | `/vendor/staff` | signed in · vendor member · `vendor.team.manage` |
| POST | `/vendor/staff` | signed in · approved vendor · `vendor.team.manage` |
| DELETE | `/vendor/staff/:id` | signed in · approved vendor · `vendor.team.manage` |
| GET | `/vendor/dashboard` | signed in · approved vendor · `vendor.jobs.view` |
| GET | `/vendor/performance` | signed in · approved vendor · `vendor.jobs.view` |
| GET | `/vendor/products` | signed in · approved vendor · `vendor.listings.manage` |
| POST | `/vendor/products` | signed in · approved vendor · `vendor.listings.manage` |
| PUT | `/vendor/products/:id` | signed in · approved vendor · `vendor.listings.manage` |
| POST | `/vendor/products/:id/active` | signed in · approved vendor · `vendor.listings.manage` |
| GET | `/vendor/jobs` | signed in · approved vendor · `vendor.jobs.view` |
| GET | `/vendor/jobs/:id` | signed in · approved vendor · `vendor.jobs.view` |
| POST | `/vendor/jobs/:id/respond` | signed in · approved vendor · `vendor.jobs.update` |
| POST | `/vendor/jobs/:id/events` | signed in · approved vendor · `vendor.jobs.update` |
| POST | `/vendor/jobs/:id/qc` | signed in · approved vendor · `vendor.jobs.update` |
| POST | `/vendor/jobs/:id/shipments` | signed in · approved vendor · `vendor.jobs.update` |
| GET | `/vendor/shipments` | signed in · approved vendor · `vendor.jobs.view` |
| POST | `/vendor/shipments/:id/tracking` | signed in · approved vendor · `vendor.jobs.update` |
| GET | `/vendor/settlements` | signed in · approved vendor · `vendor.settlements.view` |
| GET | `/vendor/settlements/:id` | signed in · approved vendor · `vendor.settlements.view` |

### Support tickets & CMS content

| Method | Path | Access |
|---|---|---|
| GET | `/content/pages` | public |
| GET | `/content/pages/:slug` | public |
| POST | `/tickets` | signed in · `tickets.create` / `tickets.manage` |
| GET | `/tickets` | signed in |
| GET | `/tickets/:id` | signed in |
| POST | `/tickets/:id/messages` | signed in |

### Administration

| Method | Path | Access |
|---|---|---|
| GET | `/admin/dashboard` | signed in · `admin.dashboard.view` |
| GET | `/admin/reports/:kind` | signed in · `reports.view` |
| GET | `/admin/categories` | signed in · `catalogue.manage` |
| POST | `/admin/categories` | signed in · `catalogue.manage` |
| PUT | `/admin/categories/:id` | signed in · `catalogue.manage` |
| DELETE | `/admin/categories/:id` | signed in · `catalogue.manage` |
| GET | `/admin/products` | signed in · `catalogue.manage` |
| POST | `/admin/products` | signed in · `catalogue.manage` |
| GET | `/admin/products/preview/:slug` | signed in · `catalogue.manage` |
| GET | `/admin/products/:id` | signed in · `catalogue.manage` |
| PUT | `/admin/products/:id` | signed in · `catalogue.manage` |
| POST | `/admin/products/:id/status` | signed in · `catalogue.manage` |
| DELETE | `/admin/products/:id` | signed in · `catalogue.manage` |
| GET | `/admin/methods` | signed in · `catalogue.manage` / `pricing.manage` |
| POST | `/admin/methods` | signed in · `pricing.manage` |
| PUT | `/admin/methods/:id` | signed in · `pricing.manage` |
| GET | `/admin/inventory` | signed in · `inventory.manage` |
| POST | `/admin/inventory/:id/adjust` | signed in · `inventory.manage` |
| GET | `/admin/inventory/:id/history` | signed in · `inventory.manage` |
| GET | `/admin/orders` | signed in · `orders.view` / `production.view` |
| GET | `/admin/orders/:id` | signed in · `orders.view` / `production.view` |
| POST | `/admin/orders/:id/cancel` | signed in · `orders.manage` |
| POST | `/admin/orders/:id/confirm` | signed in · `orders.manage` · `{ note?, estimatedDelivery? }` confirms a sales order from a quotation |
| POST | `/admin/orders/:id/close` | signed in · `orders.manage` · `{ note? }` issues the final invoice and completes a delivered, paid order |
| POST | `/admin/orders/:id/payments` | signed in · `payments.view` / `refunds.approve` |
| POST | `/admin/order-items/:id/transition` | signed in · `orders.manage` |
| GET | `/admin/order-items/:id/sources` | signed in · `production.manage` |
| POST | `/admin/order-items/:id/assign` | signed in · `production.manage` |
| GET | `/admin/proofs/queue` | signed in · `proofs.manage` |
| POST | `/admin/proofs` | signed in · `proofs.manage` |
| GET | `/admin/production/board` | signed in · `production.view` |
| GET | `/admin/production/ready` | signed in · `production.manage` · order lines ready to assign (approved, paid), most urgent first; each has `previousAttempts` (declined or withdrawn jobs) |
| POST | `/admin/production/jobs/:id/unassign` | signed in · `production.manage` · `{ reason }` takes back a job that has not started production (assigned or accepted): the job is cancelled, the vendor notified, and the line returns to the ready queue |
| GET | `/admin/production/jobs` | signed in · `production.view` |
| GET | `/admin/production/jobs/:id` | signed in · `production.view` |
| POST | `/admin/production/jobs/:id/events` | signed in · `production.manage` |
| POST | `/admin/production/jobs/:id/qc` | signed in · `qc.perform` |
| POST | `/admin/shipments` | signed in · `shipping.manage` |
| GET | `/admin/shipments` | signed in · `shipping.manage` |
| POST | `/admin/shipments/:id/tracking` | signed in · `shipping.manage` |
| GET | `/admin/payments` | signed in · `payments.view` |
| GET | `/admin/refunds` | signed in · `refunds.request` / `refunds.approve` |
| POST | `/admin/refunds` | signed in · `refunds.request` / `refunds.approve` |
| POST | `/admin/refunds/:id/decision` | signed in · `refunds.approve` |
| GET | `/admin/settlements` | signed in · `settlements.manage` |
| POST | `/admin/settlements` | signed in · `settlements.manage` |
| GET | `/admin/settlements/vendor/:id/preview` | signed in · `settlements.manage` |
| GET | `/admin/settlements/:id` | signed in · `settlements.manage` |
| POST | `/admin/settlements/:id/status` | signed in · `settlements.manage` |
| GET | `/admin/quotes` | signed in · `quotes.view` |
| GET | `/admin/users` | signed in · `customers.view` |
| POST | `/admin/users/staff` | signed in · `roles.manage` |
| POST | `/admin/users/:id/status` | signed in · `customers.manage` |
| PUT | `/admin/users/:id/roles` | signed in · `roles.manage` |
| GET | `/admin/companies` | signed in · `customers.view` |
| GET | `/admin/companies/:id` | signed in · `customers.view` |
| PUT | `/admin/companies/:id/terms` | signed in · `customers.manage` |
| GET | `/admin/vendors` | signed in · `vendors.view` / `production.manage` |
| GET | `/admin/vendors/:id` | signed in · `vendors.view` |
| POST | `/admin/vendors/:id/decision` | signed in · `vendors.manage` |
| GET | `/admin/coupons` | signed in · `coupons.manage` |
| POST | `/admin/coupons` | signed in · `coupons.manage` |
| PUT | `/admin/coupons/:id` | signed in · `coupons.manage` |
| GET | `/admin/tickets` | signed in · `tickets.manage` |
| PATCH | `/admin/tickets/:id` | signed in · `tickets.manage` |
| POST | `/admin/tickets/:id/resolve` | signed in · `tickets.manage` |
| GET | `/admin/reviews` | signed in · `reviews.moderate` |
| POST | `/admin/reviews/:id/moderate` | signed in · `reviews.moderate` |
| GET | `/admin/settings` | signed in · `settings.manage` |
| PUT | `/admin/settings/:key` | signed in · `settings.manage` |
| GET | `/admin/roles` | signed in · `roles.manage` |
| PUT | `/admin/roles/:id/permissions` | signed in · `roles.manage` |
| GET | `/admin/pages` | signed in · `cms.manage` |
| POST | `/admin/pages` | signed in · `cms.manage` |
| PUT | `/admin/pages/:id` | signed in · `cms.manage` |
| DELETE | `/admin/pages/:id` | signed in · `cms.manage` |
| GET | `/admin/audit-logs` | signed in · `audit.view` |

### Blog (public)

| Method | Path | Access |
|---|---|---|
| GET | `/blog/posts` (`q`, `category`, `tag`, `featured`, `featuredFirst`, `page`, `limit` ≤ 24) | public |
| GET | `/blog/posts/:slug` (`view=1` counts a view) | public |
| GET | `/blog/categories` | public |
| GET | `/blog/sitemap` | public |

### Blog management

| Method | Path | Access |
|---|---|---|
| GET | `/admin/blog/meta` | signed in · any blog permission |
| GET | `/admin/blog/stats` | signed in · any blog permission (own posts only without `blog.view`) |
| GET | `/admin/blog/analytics` | signed in · `blog.analytics.view` |
| GET | `/admin/blog/posts` (`q`, `status`, `categoryId`, `authorId`, `featured`, `createdFrom/To`, `publishedFrom/To`, `sort`, `page`, `limit`) | signed in · any blog permission |
| POST | `/admin/blog/posts` | signed in · `blog.create` |
| GET | `/admin/blog/posts/slug-check` | signed in · `blog.create` / `blog.edit_own` / `blog.edit_all` |
| GET | `/admin/blog/posts/:id` | signed in · any blog permission + can see the post |
| PUT | `/admin/blog/posts/:id` | signed in · `blog.edit_own` (own) / `blog.edit_all` |
| DELETE | `/admin/blog/posts/:id` | signed in · `blog.delete_own` (own) / `blog.delete_all` |
| GET | `/admin/blog/posts/:id/history` | signed in · can see the post |
| POST | `/admin/blog/posts/:id/:action` | signed in · per action (see Blog above) |
| GET | `/admin/blog/categories`, `/admin/blog/tags` | signed in · any blog permission |
| POST, PUT, DELETE | `/admin/blog/categories[/:id]`, `/admin/blog/tags[/:id]` | signed in · `blog.taxonomy.manage` |
| GET | `/admin/blog/permissions` | signed in · `blog.permissions.manage` |
| PUT | `/admin/blog/permissions/:userId` | signed in · `blog.permissions.manage` |
| PUT | `/admin/blog/settings` | signed in · `blog.permissions.manage` |

### Visiting cards (customers)

All need a signed-in buyer (`shop.purchase`). Designs and orders are checked for ownership: own individual ones, plus the company's corporate ones for `company.brand.manage`.

| Method | Path | Access |
|---|---|---|
| GET | `/visiting-cards/context` | buyer (limits, access, profile pre-fill, brand kits) |
| GET | `/visiting-cards/categories` | buyer |
| GET | `/visiting-cards/templates` (`q`, `category`, `orientation`, `doubleSided`, `qr`) | buyer · published only |
| GET | `/visiting-cards/templates/:id` | buyer · published only |
| GET | `/visiting-cards/print-options` | buyer |
| GET | `/visiting-cards/pricing` | buyer (price slabs) |
| GET | `/visiting-cards/designs` | buyer |
| POST | `/visiting-cards/designs` | buyer · `company.brand.manage` for corporate |
| GET | `/visiting-cards/designs/:id` | buyer · owner |
| PUT | `/visiting-cards/designs/:id` | buyer · owner |
| POST | `/visiting-cards/designs/:id/duplicate` | buyer · owner |
| DELETE | `/visiting-cards/designs/:id` | buyer · owner |
| POST | `/visiting-cards/employees/import` (multipart `file`) | buyer · `company.brand.manage` |
| GET | `/visiting-cards/employees/directory` | buyer · `company.brand.manage` |
| POST | `/visiting-cards/quote` | buyer · owner of the design |
| POST | `/visiting-cards/orders` | buyer · owner of the design · rate limited |
| GET | `/visiting-cards/orders` (`status`, `page`, `limit`) | buyer |
| GET | `/visiting-cards/orders/:id` | buyer · owner |
| POST | `/visiting-cards/orders/:id/cancel` | buyer · owner · unpaid only |
| PUT | `/visiting-cards/orders/:id/artwork` | buyer · owner · unpaid or artwork rejected |
| POST | `/visiting-cards/orders/:id/payments` | buyer · owner |
| GET | `/visiting-cards/orders/:id/invoice` | buyer · owner · paid |
| POST | `/visiting-cards/payments/verify` | buyer · owner |
| POST | `/visiting-cards/payments/:id/mock-complete` | buyer · owner · `PAYMENT_PROVIDER=mock` only |
| GET | `/visiting-cards/payments/:id/receipt` | buyer · owner |

### Visiting cards (administration)

| Method | Path | Access |
|---|---|---|
| GET | `/admin/visiting-cards/dashboard` | `vc.view` |
| GET | `/admin/visiting-cards/reports` (`from`, `to`) | `vc.reports.view` |
| GET | `/admin/visiting-cards/templates` (`q`, `category`, `orientation`, `status`) | `vc.view` / `vc.templates.manage` |
| POST | `/admin/visiting-cards/templates` | `vc.templates.manage` (created as `draft`) |
| GET | `/admin/visiting-cards/templates/:id` | `vc.view` / `vc.templates.manage` |
| PUT | `/admin/visiting-cards/templates/:id` | `vc.templates.manage` |
| POST | `/admin/visiting-cards/templates/:id/status` (`published` / `unpublished`) | `vc.templates.manage` |
| POST | `/admin/visiting-cards/templates/:id/duplicate` | `vc.templates.manage` |
| DELETE | `/admin/visiting-cards/templates/:id` | `vc.templates.manage` (soft delete) |
| GET | `/admin/visiting-cards/categories` | `vc.view` / `vc.templates.manage` |
| POST | `/admin/visiting-cards/categories` | `vc.templates.manage` |
| PUT | `/admin/visiting-cards/categories/:id` | `vc.templates.manage` |
| DELETE | `/admin/visiting-cards/categories/:id` | `vc.templates.manage` |
| GET | `/admin/visiting-cards/orders` (`q`, `status`, `paymentStatus`, `artworkStatus`, `customerType`, `from`, `to`, `minQty`, `maxQty`, `companyId`, `userId`, `page`, `limit`) | `vc.view` |
| GET | `/admin/visiting-cards/orders/:id` | `vc.view` |
| POST | `/admin/visiting-cards/orders/:id/artwork` | `vc.orders.manage` |
| POST | `/admin/visiting-cards/orders/:id/status` | `vc.orders.manage` |
| PUT | `/admin/visiting-cards/orders/:id/tracking` | `vc.orders.manage` |
| POST | `/admin/visiting-cards/orders/:id/cancel` (`reason`, `refund`) | `vc.orders.manage` (+ `vc.payments.manage` to refund) |
| POST | `/admin/visiting-cards/orders/:id/offline-payment` | `vc.payments.manage` |
| GET | `/admin/visiting-cards/orders/:id/invoice` | `vc.payments.view` |
| GET | `/admin/visiting-cards/customers/:type` (`corporate` / `individual`) | `vc.view` |
| GET | `/admin/visiting-cards/payments` (`q`, `status`) | `vc.payments.view` |
| GET | `/admin/visiting-cards/payments/:id/receipt` | `vc.payments.view` |
| GET | `/admin/visiting-cards/pricing` | `vc.pricing.manage` |
| PUT | `/admin/visiting-cards/pricing/slabs` (whole table; no gaps or overlaps) | `vc.pricing.manage` |
| POST | `/admin/visiting-cards/pricing/preview` | `vc.pricing.manage` |
| GET | `/admin/visiting-cards/print-options` | `vc.view` / `vc.pricing.manage` |
| POST | `/admin/visiting-cards/print-options` | `vc.pricing.manage` |
| PUT | `/admin/visiting-cards/print-options/:id` | `vc.pricing.manage` |
| DELETE | `/admin/visiting-cards/print-options/:id` | `vc.pricing.manage` |
| GET | `/admin/visiting-cards/settings` | `vc.view` / `vc.pricing.manage` |
| PUT | `/admin/visiting-cards/settings` | `vc.pricing.manage` |

### Webhooks

| Method | Path | Access |
|---|---|---|
| POST | `/webhooks/razorpay` | public |
| POST | `/webhooks/shipping` | public |
