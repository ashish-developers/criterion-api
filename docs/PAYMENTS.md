# Payment gateways: Razorpay and PayPal

Customers pay shop orders and visiting card orders through Razorpay and/or PayPal. Both gateways are configured in the API's `.env` file (`RAZORPAY_*`, `PAYPAL_*`, `PAYMENT_DEFAULT_GATEWAY`). **Admin → Settings → Payment gateway settings** (permission `settings.manage`) shows them read-only, lists missing values and can test the connection. The checkout offers only the gateways that are enabled and complete. Nothing about gateway availability is hard-coded in the web app.

## How it works

| Step | Razorpay | PayPal |
|---|---|---|
| 1. Start | `POST /orders/:id/payments { gateway: "razorpay" }`. The server creates a Razorpay order for the amount due (INR, paise) | `POST /orders/:id/payments { gateway: "paypal" }`. The server creates a PayPal order (Orders v2, `intent: CAPTURE`, `PayPal-Request-Id` for idempotency) in the configured currency |
| 2. Pay | Razorpay Checkout (`checkout.js`) shows UPI, cards, net banking and wallets, as enabled on your Razorpay account | PayPal JS SDK Smart Buttons for that order |
| 3. Confirm | `POST /payments/verify`: the server checks the signature, **fetches the payment from Razorpay**, checks the order id, amount, currency and status, and captures it if it is only authorized | `POST /payments/paypal/capture`: the **server captures** the order with PayPal and checks the capture status, amount, currency and `custom_id` |
| 4. Safety net | `POST /webhooks/razorpay` (`payment.captured`, `order.paid`, `payment.failed`) | `POST /webhooks/paypal` (`CHECKOUT.ORDER.APPROVED`, `PAYMENT.CAPTURE.COMPLETED` / `PENDING` / `DENIED` / `DECLINED`) |

Visiting card orders use the same flow under `/visiting-cards/orders/:id/payments`, `/visiting-cards/payments/verify` and `/visiting-cards/payments/paypal/capture`. Both share the same webhooks.

The code is in `src/Services/`:
- `gatewayService.js`: settings from `.env`, connection tests and which gateway a payment may use.
- `gatewayCheckout.js`: opening, verifying and capturing payments, webhooks and refunds, shared by both ledgers.
- `paymentProviders.js`: the HTTP adapters for the Razorpay and PayPal APIs.

## Database

Migration `013_payment_gateways.sql`:
- **`payment_gateways`**: one row per gateway, from when gateways were configured in the admin panel. **No longer read**: the configuration moved to `.env`. The rows (with their encrypted secrets) are kept unchanged.
- **Transactions** stay in the existing ledgers, `payments` (shop orders) and `vc_payments` (visiting cards). No duplicate table is created. Each row has:
  - `order_id`, with the customer through the order;
  - `provider` (now also `paypal`);
  - `provider_order_id` and `provider_payment_id` (the gateway transaction id, unique per gateway);
  - `amount_paise` and `currency` (INR, the order ledger);
  - `gateway_amount` and `gateway_currency` (what the gateway actually charged);
  - `gateway_mode`, `status`, `method`;
  - `raw`: the gateway's confirmation data, without card or contact details;
  - `captured_at`, `created_at`.

Run `npm run db:migrate` to apply it.

## Environment

| Variable | Purpose |
|---|---|
| `PAYMENT_PROVIDER` | `mock` also offers a simulated gateway (development only; refused when `APP_ENV=production`). Use `none` otherwise |
| `PAYMENT_DEFAULT_GATEWAY` | `razorpay` or `paypal`: pre-selected at checkout when both are enabled |
| `PUBLIC_API_URL` | Public base address used to build the webhook URLs shown in the admin panel, e.g. `https://your-domain` |
| `RAZORPAY_ENABLED`, `RAZORPAY_MODE` | `true`/`false`; `test` or `live` |
| `RAZORPAY_KEY_ID`, `RAZORPAY_KEY_SECRET` | API keys for that mode (`rzp_test_…` or `rzp_live_…`) |
| `RAZORPAY_WEBHOOK_SECRET` | The secret chosen when adding the webhook in Razorpay |
| `PAYPAL_ENABLED`, `PAYPAL_MODE` | `true`/`false`; `test` (Sandbox) or `live` |
| `PAYPAL_CLIENT_ID`, `PAYPAL_CLIENT_SECRET` | Credentials of a Sandbox or Live app |
| `PAYPAL_WEBHOOK_ID` | The Webhook ID of the webhook added in the PayPal app |
| `PAYPAL_CURRENCY`, `PAYPAL_EXCHANGE_RATE` | Charge currency (PayPal does not take INR) and rupees per 1 unit |

Restart the API after changing any of these. `npm run config:check` checks them without taking a payment: Razorpay with a read-only Orders API call, PayPal by requesting an OAuth token.

## Setup

1. **Razorpay.** Copy the Key ID and Key Secret from Razorpay Dashboard → Account & Settings → API Keys. Test keys start with `rzp_test_`, live keys with `rzp_live_`.
2. **PayPal.** In the PayPal Developer Dashboard → Apps & Credentials, copy the Client ID and Client Secret of a Sandbox app (test) or a Live app. PayPal does not accept INR for these payments, so choose a charge currency (USD by default) and set **₹ per 1 unit**. Amounts are converted at that rate and rounded up to the cent. Keep the rate current: it is not updated automatically.
3. Put the values in `.env`, restart the API, then run `npm run config:check` or click **Test connection** on the admin page. The card shows Enabled, Disabled or Not configured (with the missing variables).
4. **Webhooks.** Each card shows its webhook URL.
   - **Razorpay:** Dashboard → Webhooks → add the URL, choose a secret, and select `payment.captured`, `payment.failed` and `order.paid`. Put the secret in `RAZORPAY_WEBHOOK_SECRET`.
   - **PayPal:** in the app's Webhooks → add the URL with the five events above, then put the **Webhook ID** in `PAYPAL_WEBHOOK_ID`.
   - Without these, webhooks are rejected. Browser-side confirmation still works, but a customer who closes the window after paying is only recorded once the webhook arrives.
5. **Enable** the gateway (`RAZORPAY_ENABLED=true` / `PAYPAL_ENABLED=true`) and optionally set `PAYMENT_DEFAULT_GATEWAY`.
6. **Going live.** Replace the keys with the live ones, set the mode to `live`, restart and test. `.env` holds one set of keys per gateway, so payments still open in test mode can no longer be confirmed (`409 GATEWAY_MODE_CHANGED`); finish or cancel them before switching.

## Security

- **Secrets.** Secrets live only in the server's `.env` (git-ignored) and are never returned by the API or logged. The admin page shows only whether each is set. The browser receives only the public Key ID / Client ID.
- **Verification.** A payment counts only after the gateway's server API confirms it: a signature plus a payment fetch for Razorpay, a server-side capture or order fetch for PayPal. Amount and currency must match the payment that was opened for the order's amount due. A mismatch is logged and the payment marked failed.
- **No duplicate processing.**
  - Capture locks the payment and order rows and is idempotent.
  - Webhook events are de-duplicated by event id.
  - Gateway order and payment ids are unique.
  - Open payments are reused.
  - PayPal create, capture and refund calls carry `PayPal-Request-Id`.
  - A payment that lands on an already-paid visiting card order is refunded automatically.
- **Access.** Gateway settings need `settings.manage`, transactions need `payments.view`, and paying needs `shop.purchase` plus ownership of the order. Request bodies are validated (zod). Payment endpoints are rate limited.
- **Browser choice.** The gateway a customer picks is re-checked on the server; a disabled gateway cannot be forced.
- **Logging.** Gateway failures are logged as `[payments] <gateway> <method> <path> failed (<status>): <error code>`, without request bodies or credentials.

## Testing

### Automated

```bash
cd api
npm test                                                     # whole suite
node --test --test-concurrency=1 tests/payment-gateways.test.js
```

`tests/payment-gateways.test.js` replaces Razorpay's and PayPal's servers with an in-process fake. The real code still signs, verifies, captures and checks amounts. It covers:
- admin access, write-only and encrypted secrets, key-prefix validation, connection test results;
- Razorpay and PayPal both enabled, Razorpay only, PayPal only, both disabled, and a disabled gateway forced from the browser;
- a Razorpay success, a failed Razorpay payment, an invalid signature, and a modified amount;
- a PayPal sandbox-style success, a cancelled PayPal payment (the PayPal order is reused), a declined funding source, a modified capture amount, and a forged order id;
- Razorpay and PayPal webhooks: invalid signature, duplicate notification, wrong amount;
- switching Razorpay from test to live while a test payment is open;
- transaction search, filters, date range and detail.

### Manual (sandbox)

1. Set `PAYMENT_PROVIDER=none` in `api/.env` to hide the simulated gateway, restart the API, and enter **test** credentials for both gateways in the admin panel.
2. For webhooks on a local machine, expose the API (e.g. `ngrok http 4001`), set `PUBLIC_API_URL` to the tunnel address, and register the URLs.
3. Place an order and pay:
   - **Razorpay success:** UPI `success@razorpay`, or card `4111 1111 1111 1111` with any future expiry and CVV.
   - **Razorpay failure:** UPI `failure@razorpay`.
   - **PayPal success:** log in with a sandbox *personal* account (Developer Dashboard → Sandbox → Accounts).
   - **PayPal cancel:** close the PayPal window and check the order stays unpaid and can be paid again.
4. Check Admin → Payment transactions. The transaction shows the gateway's id, and the order shows as paid only after a verified success.
5. Try each enable/disable combination and check the checkout's payment options. With both disabled, checkout shows "Online payments are temporarily unavailable".
6. Replay a webhook from the gateway dashboard. The order must not be paid twice, and the transaction detail lists the event once.
