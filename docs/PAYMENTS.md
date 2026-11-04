# Payment gateways: Razorpay and PayPal

Customers pay shop orders and visiting card orders through Razorpay and/or PayPal. Admins manage both gateways in **Admin → Settings → Payment gateway settings** (permission `settings.manage`). The checkout offers only the gateways that are enabled there. Nothing about gateway availability is hard-coded in the web app.

## How it works

| Step | Razorpay | PayPal |
|---|---|---|
| 1. Start | `POST /orders/:id/payments { gateway: "razorpay" }`. The server creates a Razorpay order for the amount due (INR, paise) | `POST /orders/:id/payments { gateway: "paypal" }`. The server creates a PayPal order (Orders v2, `intent: CAPTURE`, `PayPal-Request-Id` for idempotency) in the configured currency |
| 2. Pay | Razorpay Checkout (`checkout.js`) shows UPI, cards, net banking and wallets, as enabled on your Razorpay account | PayPal JS SDK Smart Buttons for that order |
| 3. Confirm | `POST /payments/verify`: the server checks the signature, **fetches the payment from Razorpay**, checks the order id, amount, currency and status, and captures it if it is only authorized | `POST /payments/paypal/capture`: the **server captures** the order with PayPal and checks the capture status, amount, currency and `custom_id` |
| 4. Safety net | `POST /webhooks/razorpay` (`payment.captured`, `order.paid`, `payment.failed`) | `POST /webhooks/paypal` (`CHECKOUT.ORDER.APPROVED`, `PAYMENT.CAPTURE.COMPLETED` / `PENDING` / `DENIED` / `DECLINED`) |

Visiting card orders use the same flow under `/visiting-cards/orders/:id/payments`, `/visiting-cards/payments/verify` and `/visiting-cards/payments/paypal/capture`. Both share the same webhooks.

The code is in `src/Services/`:
- `gatewayService.js`: settings, encryption, connection tests and which gateway a payment may use.
- `gatewayCheckout.js`: opening, verifying and capturing payments, webhooks and refunds, shared by both ledgers.
- `paymentProviders.js`: the HTTP adapters for the Razorpay and PayPal APIs.

## Database

Migration `013_payment_gateways.sql`:
- **`payment_gateways`**: one row per gateway. It holds the enabled flag, mode (`test`/`live`), the default flag, and the public key for each mode (Razorpay Key ID, PayPal Client ID). The secrets for each mode (Razorpay key and webhook secret, PayPal client secret and webhook ID) are stored AES-256-GCM encrypted. It also holds the charge currency and exchange rate, the last connection test, and created/updated timestamps with the admin who saved them.
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
| `APP_KEY` | Encrypts gateway secrets. Keep it stable once secrets are saved; if it changes, re-enter the secrets |
| `PAYMENT_PROVIDER` | `mock` also offers a simulated gateway (development only; refused when `APP_ENV=production`). Use `none` in production |
| `PUBLIC_API_URL` | Public base address used to build the webhook URLs shown in the admin panel, e.g. `https://your-domain` |
| `WEB_APP_URL` | Must be `https://` before a gateway can be enabled in live mode when `APP_ENV=production` |
| `RAZORPAY_KEY_ID`, `RAZORPAY_KEY_SECRET`, `RAZORPAY_WEBHOOK_SECRET` | Legacy only. At startup they are imported once into the Razorpay settings if that gateway was never saved in the admin panel. Remove them afterwards |

## Admin setup

1. **Razorpay.** Copy the Key ID and Key Secret from Razorpay Dashboard → Account & Settings → API Keys. Test keys start with `rzp_test_`, live keys with `rzp_live_`.
2. **PayPal.** In the PayPal Developer Dashboard → Apps & Credentials, copy the Client ID and Client Secret of a Sandbox app (test) or a Live app. PayPal does not accept INR for these payments, so choose a charge currency (USD by default) and set **₹ per 1 unit**. Amounts are converted at that rate and rounded up to the cent. Keep the rate current: it is not updated automatically.
3. **Save settings**, then **Test connection**. Razorpay is tested with a read-only Orders API call; PayPal by requesting an OAuth token. The card shows the status: Connected, Connection failed, Not tested, Not configured or Disabled.
4. **Webhooks.** Each card shows its webhook URL.
   - **Razorpay:** Dashboard → Webhooks → add the URL, choose a secret, and select `payment.captured`, `payment.failed` and `order.paid`. Paste the secret into **Webhook secret**.
   - **PayPal:** in the app's Webhooks → add the URL with the five events above, then paste the **Webhook ID** into the card.
   - Without these, webhooks are rejected. Browser-side confirmation still works, but a customer who closes the window after paying is only recorded once the webhook arrives.
5. **Enable** the gateway and optionally make it the **default** (pre-selected at checkout). Disabling asks for confirmation. Payments already in progress are still confirmed by their webhooks.
6. **Going live.** Enter the live credentials, switch the mode to Live (this asks for confirmation), save, and test. Test credentials are kept. Payments opened in test mode are still verified with the test keys.

## Security

- **Secrets.** Secrets are encrypted at rest and never returned by the API. The admin form shows only "saved (••••abcd)". The browser receives only the public Key ID / Client ID. The audit log records every save and test without secrets.
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
