# Instanta: hardening, deployment and partner integration

This change adds tested defensive foundations. It **does not certify production
readiness, NDPC compliance, SEC authorization or partner approval**. Do not handle
customer funds until the launch gates below are independently satisfied.

## Start and migrate safely

Requires the Node version in `package.json`, PostgreSQL 17, and Docker Compose
for local development. Never run integration tests against an existing database.

```sh
npm install
npm run db:prepare
npm run pii:migrate
npm run dev:services
```

`dev:services` starts API, UI and a separate durable-job worker. `npm run dev`
also prepares Docker and migrations first. `pii:migrate` is required once when
upgrading legacy users; it encrypts existing email/names/phones, clears legacy
plaintext phones and creates blind lookup indexes. Take an encrypted backup
first. Legacy phone numbers must be verified Nigerian E.164 (`+234...`).
Accounts with no phone require identity-verified support enrollment; do not
allow an unauthenticated caller to replace their OTP destination.

Production release sequence:

1. Supply secrets from your deployment secret manager, not a committed file.
2. Run `npm run db:generate`, then `npm run build` in the build environment.
3. Run `npm run db:deploy` once through a migration job with a separate DDL role.
4. Run `npm run pii:migrate` if upgrading existing profiles.
5. Start API with `npm start`, worker with `node dist/worker.js`.
6. Confirm database readiness, worker lag and alerts before accepting traffic.

The landing website is `/`; the dashboard is `/app` and live sign-in is
`/app?mode=live`. Production landing HTML is prerendered for crawlers. Replace
generic metadata with the verified production domain and publish the applicable
privacy notice and terms before launch. No invented performance or licensing
claims are included.

The new deferred ledger constraints can reject existing corrupt data. Perform a
pre-deployment journal/balance reconciliation first; fix with audited compensating
entries, not rewritten financial history. Migrations changing legacy savings
dates explicitly interpret them as UTC.

## Configuration

| Variable | Purpose / behavior |
| --- | --- |
| `NODE_ENV` | `development`, `staging`, `test` or `production`; production disallows mocks |
| `DATABASE_URL` | PostgreSQL URL; TLS and a least-privileged runtime role required in production |
| `DB_POOL_MAX` | Per-process pool size (default 10); budget API + worker + replica pools against PostgreSQL capacity |
| `JWT_SECRET` | At least 32 random characters, no example placeholders |
| `PII_ENCRYPTION_KEY` | 32 random bytes encoded as 64 hex characters |
| `BAAS_WEBHOOK_SECRET`, `KYC_WEBHOOK_SECRET` | Independent random signing keys of at least 32 characters |
| `SYSTEM_READ_ONLY_MODE` | `true` blocks financial postings, goal mutations and ATP persistence in that process |
| `IS_DEMO_MODE` | Default `false`. `true` forces database-only simulation, requires a separate `_demo` database without real-mode users, and is forbidden in production |
| `KYC_GATEWAY_URL`, `KYC_API_KEY` | Certified normalization gateway for YouVerify/Smile ID |
| `BAAS_GATEWAY_URL`, `BAAS_API_KEY` | Certified normalization gateway for Anchor/Maplerad/SafeHaven |
| `FUND_GATEWAY_URL`, `FUND_API_KEY` | SEC-licensed fund manager/custodian normalization gateway |
| `SMS_GATEWAY_URL`, `SMS_API_KEY` | Notification gateway implementing Termii/Africa's Talking delivery |

All four gateway URL/key pairs are required at **API and worker startup in
production** and must use HTTPS. Missing credentials never cause a live failure
to switch to mock. Development/staging prints a yellow warning:

`[WARN] LIVE API KEY MISSING: Falling back to secure mock mode for [Partner Name]`

Local JWT/encryption/webhook secrets are still required; never use production
secrets or customer identity data in mock mode. Older `KYC_PROVIDER_URL` and
`KYC_PROVIDER_API_KEY` variables are superseded by the gateway variables.

### Mock behavior

- Only BVN/NIN `00000000000` passes mock KYC; other test values are rejected.
- Mock accounts have a `MOCK-` prefix and explicit simulated bank name, not a
  real routable NUBAN. Never transfer real money using mock details.
- Mock fund batches use fixed NAV 100 and decimal unit calculations. They are
  recorded only in `PartnerExecution`, **not** customer cash ledgers.
- OTP delivery logs the challenge/code only with `NODE_ENV=development`.
  Use a private local console, not shared log aggregation. Test mode logs no
  OTP; staging requires a real notification gateway to complete sign-in.
- No mock marks real external funds as settled.

## Password recovery

The sign-in form includes **Forgot password?**. The API also accepts:

1. `POST /api/v1/auth/forgot-password` with `{ "contact": "email or +234 phone" }`.
   Aliases `email` or `phone` are accepted instead of `contact`, but supply only one.
   Always returns the same message, a random challenge ID and 900-second expiry;
   missing, locked or unenrolled accounts do not reveal their existence.
2. `POST /api/v1/auth/verify-recovery-otp` with `{ "challengeId": "...", "code": "123456" }`.
   A successful verification returns a random 256-bit reset token, held only
   in browser memory. Only its HMAC hash is stored. OTPs and grants are bound to
   the requesting device/IP; the original 15-minute deadline applies to both.
3. `POST /api/v1/auth/reset-password` with `{ "resetToken": "...", "password": "..." }`.
   Passwords need at least 12 characters and at most 72 UTF-8 bytes, hashed using
   bcrypt with 12 rounds. Success invalidates every session, pending login
   challenge and recovery grant. The user must sign in again.

Recovery sends only to the existing registered phone through the encrypted,
durable notification outbox. An email input is a lookup key, not permission to
choose a new destination. Run the worker. Missing development SMS credentials
produce the existing yellow mock warning and private-console OTP; production
requires real delivery, and ordinary staging fails closed without SMS.
An account without a registered phone needs identity-verified support recovery.
Codes never appear in HTTP responses or audit events.

Three wrong recovery codes persistently lock the account for one hour, including
login and authenticated requests. A new challenge never resets that counter.
After the hour, a fresh request can begin a new attempt window. Verification is
single-use. Password/session issuance serializes on the user row with a
credential version, preventing an old in-flight login from surviving a reset.
Issuance is limited to five requests per contact per hour and 30 recovery requests
per IP per 15 minutes. Audit logs record requests, failures, lockouts, phone access
and resets. IP limits use the socket peer; configure trusted ingress deliberately.

## Unified portfolio and isolated demo

`/api/v1/wealth/products` combines Nigerian NGX/FMDQ and Perpetuals products.
Unavailable sources are returned explicitly with warnings, not silently replaced.
`/wealth/summary` aggregates accounting books in a repeatable-read snapshot.
The UI no longer has Local/Global navigation. Currency, source and accounting
mode remain explicit. No FX parity, real crypto custody or real global execution
is implied. Existing `/perpetuals/*` routes remain backward-compatible aliases;
new UI calls use `/wealth/*`. Naira paper trading is restricted to isolated demo.

The table reports purchase cost, not a fabricated current sale value.
Saved plans do not inflate balances. Drift is the saved calculation's snapshot,
not a live daily risk monitor. Loss-floor estimates are not guarantees.
Goal auto-sweep remains a preference, not an implemented scheduler.

For demo setup, follow the separate `.env.demo`, Compose project and port
instructions in [README.md](./README.md). The existing `.env` is not modified.
Demo profiles have `isDemo=true`; startup rejects mixed-mode databases and auth
rejects mode-mismatched accounts. Demo sessions use a random per-tab 256-bit
fictional identity, not a customer login; opening/refreshing it never refills funds.
Each demo user gets a permanent idempotent NGN 5,000,000 and USD 10,000 credit.
No goals, positions or fills are preloaded. Calculators still start at zero.

`DemoInstrument` holds fictional Nigerian bills, MMF, shares/ETF, crypto,
tokenized share and index prices in PostgreSQL. These are controlled sample prices,
not exchange prices; change test prices in the dedicated demo database to
exercise volatility. Quotes read that table; no external price socket opens.
Demo trading, cost/profit accounting, savings and saved plans run locally.
Savings atomically move virtual NGN cash into the demo-only core savings book;
no bank payment occurs and totals are not double-counted. Equal-weight
rebalancing sells before buying, rounds to quantity steps, stays within each
currency, and is covered by HTTP idempotency. Residual cash can remain; this
is a simple practice policy, not ATP advice.

Partner factories ignore credentials in demo; outbound gateway transport
rejects attempts, BayesShield explicitly reports no estimate, licensed feeds
read demo tables, notifications stay local, and bank/KYC webhooks reject with 403.
Development/staging demo OTPs may use a private console; never collect these
logs centrally. Tests never print codes. Real-mode production still requires
certified live credentials. Enforce infrastructure egress restrictions before
hosting demos; code guards do not replace network/tenant isolation.

Adminer is available through `npm run db:adminer`, an opt-in `tools` Compose
profile bound to `127.0.0.1:8080`, default server `db`. Never deploy this profile
to production or edit balances through it.

Validation: `npm test` runs non-database tests; `npm run test:integration` needs
a disposable database ending `_hardening_test`. `npm run test:demo` requires a
different disposable `_demo` database with migrations applied. Never target
customer databases. Demo tests deny external fetch/socket connections while all
provider keys are set, covering funding once, trading/replay, savings totals,
concurrent spending, streams, local rebalancing and webhook rejection.

## Gateway contract and vendor certification boundary

The named live classes are **scaffolds targeting your normalization gateway**,
not unverified copies of a vendor's direct API. The gateway must implement the
following contracts, translate to the contracted provider/version, verify
provider-specific signatures/IP policies and status semantics, and durably honor
`Idempotency-Key`. Map NIBSS notifications to confirmed settlement events, never
pending transfers. Obtain partner certification before pointing at live traffic.
The gateway API uses POST JSON and an Authorization bearer API key.

| Gateway | Request | Successful JSON response |
| --- | --- | --- |
| KYC | `{ reference, userId, bvn?, nin? }` | `{ reference, status: "PENDING"\|"VERIFIED"\|"REJECTED", simulated: false }` |
| BaaS | `{ userId, currency: "NGN" }` | `{ accountNumber: "10 digits", accountName, bankName, simulated: false }` |
| Fund manager | `{ batchId, orders: [{ id, asset, amount: "decimal" }] }` | `[{ id, amount, nav, units, simulated: false }]` |
| Notification | `{ destination, message }` | `{ accepted: true }` |

The timeout is 10 seconds. Three consecutive failures open a per-process circuit
for 30 seconds; one half-open probe tests recovery. Failures emit `[ALERT]` logs.
Wire those logs and dead-job/lag metrics to your engineering incident system.
Multi-replica shared circuit state/rate budgets need deployment-level tuning.

Late in-flight responses cannot close an already-open circuit. Invalid JSON,
uncorrelated KYC references, mismatched fund batches and non-finite or
non-positive NAV/units count as partner failures. Gateway URLs must not contain
embedded credentials or fragments. The KYC response reference must echo the
submitted verification reference.

**Live trading remains intentionally disabled.** The adapter contract exists,
but no public order execution endpoint is enabled. Implement partner-verified
cash reservation, order lifecycle, rejection/cancellation, custody, fees, and
settlement reconciliation before enabling real batch placement.
`simulateFundBatch` is non-production paper execution only.

## Licensed Nigerian market charts

Open **Explore assets** and choose an NGX/FMDQ instrument. The unified view shows
one month of dated local observations and an accessible price table; global
products use the same selector with streamed prices. The local history API also
supports 3M and 1Y ranges. Market-data reads never execute orders. Isolated demo
starts with virtual cash but no goals or holdings. Calculator inputs still start
at zero. Existing real records are preserved.

Market routes require the existing device-bound login and are limited to 60
requests per user per minute. Successful provider responses are cached for 60
seconds per API process; concurrent identical fetches are coalesced. Provider
timeouts are 10 seconds and circuit breakers apply. Missing credentials produce
`MARKET_DATA_NOT_CONFIGURED`, not simulated prices and not an app startup failure.

**NGX direct integration:** obtain a subscription and set `NGX_API_TOKEN` only
on the server. The adapter uses the documented
`https://marketdataapiv3.ngxgroup.com/v3/api/quote/stockquotes.json` catalog
and `/v3/api/price/interdayprices.json?s=...&f=YYYY-MM-DD&t=YYYY-MM-DD`.
NGX's `_t` token is added server-side; never expose/log outgoing request URLs
in APM/proxies because this parameter is sensitive. The chart normalizes the
documented .NET-tick OHLCV arrays into chronological **daily closing prices**.
Instrument lists come from the subscription, not a hardcoded list. Equity/ETF
availability depends on entitlements. Prices are not advertised as real-time.

Public contracts and examples were checked against
[NGX documentation](https://marketdataapiv3.ngxgroup.com/portal/Home/Documentation),
[quote sample](https://marketdataapiv3.ngxgroup.com/portal/samples/stockquotes.json)
and [OHLCV sample](https://marketdataapiv3.ngxgroup.com/portal/samples/interdayprices.json).
Samples are used only to understand the contract, never as chart data. Live
authenticated responses still require verification with your licensed account.

**FMDQ connector boundary:** the e-Markets website is not a verified public API
contract. No HTML scraping or guessed vendor endpoints are used. Configure
`FMDQ_MARKET_GATEWAY_URL` (HTTPS) and `FMDQ_MARKET_API_KEY` for your licensed
normalization gateway. This is a connector, **not** a completed direct FMDQ
API integration. Your gateway must map the contracted FMDQ feed as follows:

- POST JSON with bearer key, `{ "operation": "instruments" }` returns
  `{ "provider": "FMDQ", "instruments": [{ "symbol": "your-feed-id", "name": "your-feed-label",
  "category": "TREASURY_BILL", "unit": "PERCENT" }] }`.
- Categories: `TREASURY_BILL`, `FGN_BOND`, `RATE`. Units: `NGN`, `PERCENT`
  (e.g. `"18.125"` means 18.125%, not 0.18125), or `PRICE_PER_100` for clean bond prices.
  Distinct price and yield series must use distinct symbols.
- `{ "operation": "history", "symbol": "...", "from": "YYYY-MM-DD", "to": "YYYY-MM-DD" }`
  returns `{ "provider": "FMDQ", "symbol": "...", "unit": "PERCENT",
  "frequency": "FIXING", "fetchedAt": "UTC ISO timestamp",
  "points": [{ "at": "UTC ISO timestamp", "value": "decimal string" }] }`.
  `END_OF_DAY` is also supported for closing prices.
- Dates must be unique, chronological and within the requested inclusive date range;
  return an empty `points` array when no observations exist. Never fill gaps with zeros.
  Map official observation dates accurately to UTC, preserving the Lagos date.

API: `GET /api/v1/markets/instruments?provider=NGX|FMDQ`,
`GET /api/v1/markets/history?provider=NGX|FMDQ&symbol=...&range=1M|3M|1Y`.
Confirm the vendor's display/redistribution licensing before granting users access;
production approval and entitlement-level access controls remain release gates.

## Global integration: sandbox first

This integration implements the explicitly selected **sandbox-first, no
real-money orders or FX** scope. It is not permission to distribute derivatives,
tokenized securities or stablecoins in Nigeria or any other jurisdiction.
Contract onboarding, client eligibility, sanctions/AML, venue conformance,
custody, treasury/FX, settlement reconciliation and legal review remain launch gates.

### Verified venue contract, not the proposed URL assumptions

Contracts checked against [Kronos X REST](https://docs.perpetuals.com/rest.html),
[WebSocket](https://docs.perpetuals.com/websocket.html), [trading rules](https://docs.perpetuals.com/trading.html),
and the public [sandbox OpenAPI](https://sandbox.mtf.perpetuals.net/openapi.json).
The documentation pages have inconsistent sandbox hostnames; the environment
landing page and fetched OpenAPI use `.net`, which this implementation uses.
Confirm the issued hostname and product entitlements at onboarding.

- Sandbox REST: `https://sandbox.mtf.perpetuals.net`; production market reads:
  `https://production.mtf.perpetuals.com`.
- Public `/v1/instruments` and `/v1/mark-price`; private `/v1/orders` and
  `/v1/positions/end-clients?clientUid=...`.
- Private headers: `X-API-Key`, `X-Timestamp`, `X-Signature`.
  HMAC-SHA256 signs **timestamp + uppercase method + exact path/query + raw body**
  without separators or host. The official signing vector is tested.
- Venue symbols are metadata-driven (e.g. `BTC-USD-PERP`), not universally
  `[SYMBOL][QUOTE]`. No alias rewriting invents a tradable listing. Fictional
  mock stocks, commodity and index instruments use a `SIM-` prefix.
- Public venue socket is `/ws/public`; subscribe to `ticker.SYMBOL`,
  `markIndex.SYMBOL`, `trades.SYMBOL`, `orderbook.25.SYMBOL`.
  The requested `/perpetuals/quotes`, `/marks`, `/trades` are **Instanta gateway
  paths**, not upstream exchange paths.
- Standard `PERP` products have member-level margin and liquidation.
  End-client records are attribution, not isolated margin accounts. Barrier
  products have distinct RFQ/premium/expiry/fee terms; product-specific terms
  must be verified before any capped-loss promise or execution is enabled.

### Environment and failure behavior

| Variable | Behavior |
| --- | --- |
| `PERPETUALS_ENVIRONMENT` | `sandbox` by default; `production` allows venue market reads, never real order placement |
| `PERPETUALS_API_KEY`, `PERPETUALS_API_SECRET` | Separate server-side venue credentials; no browser exposure |
| `BAYESSHIELD_GATEWAY_URL`, `BAYESSHIELD_API_KEY` | Optional contracted normalization gateway; not an invented direct AI API |

Missing venue credentials in development/staging/test emit the yellow warning:
`[WARN] PERPETUALS.COM API KEY MISSING: Falling back to simulated global market feed`.
Production API startup refuses missing venue credentials; live API failures
never switch to simulation. Local provider startup validation remains unchanged.
Configured venue calls use a ten-second timeout, three-failure circuit breaker
and the venue's `retryAfterMs` cooldown. Rate limits, unknown/invalid responses
and engine-level `status: REJECTED` are explicit errors.

`submitSandboxOrder` is a **transport primitive for conformance tests**, not an
Instanta trading endpoint. It refuses production and mock mode. It performs the
two-level gateway/engine check and checks client/symbol/order correlation. No
automatic order retry occurs. A timeout or malformed acknowledgment is ambiguous:
reconcile the original `clOrdId` through venue durable history before any retry.
The public paper order route never calls this method. Complete private-event
cursor backfill, fill/fee/funding reconciliation and durable sandbox order-intent
tracking before exposing actual venue submission to users.

### Paper wallet, accounting and execution boundaries

New paper accounts have **zero** USD/USDT/USDC, no positions and no orders.
Paper units are not held on behalf of users, not redeemable and not guaranteed
to peg to USD. They are never summed with NGN, mixed with live venue member
balances, or converted between assets at an assumed 1:1 rate.

Five new paper tables are installed by the `20261025070000_global_paper`
migration. Amounts/quantities are decimal strings stored in `DECIMAL(30,8)`.
Serializable transactions and a per-user transaction advisory lock serialize
paper balances and positions. Permanent funding/order keys survive the 24-hour
HTTP response cache. Different payloads with the same key conflict. Retries of
committed orders do not require current upstream availability or prices.

Journal templates (each asset is balanced independently):

- Explicit paper credit: debit cash asset, credit simulated capital.
- Fully funded buy: debit position cost asset, credit cash asset.
- Sell: debit cash proceeds, credit released average cost; debit realized loss
  or credit realized gain for the difference. Partial-sale cost rounds down to
  eight decimals; full exit releases the exact remainder.

Deferred DB constraints reject orphan/unbalanced/cross-asset journals and
cached-balance or position-cost divergence. Journals, lines and paper orders
are immutable. Paper mutations honor both kill switches; portfolio reads stay
available. The public paper routes cannot short, borrow, submit a perpetual,
negotiate a barrier, transfer crypto or move real NGN. Paper pricing uses fresh
indicative marks, quantity/tick grids and explicit limit checks; fees are modeled
as zero and liquidity/slippage are **not** execution guarantees.

### Risk scoring and premium-loss scenarios

The risk gateway receives `{ symbol, side, qty, price }` as a bearer-authenticated
POST. It must echo those four fields and return:

```json
{
  "symbol": "BTCUSDT", "side": "BUY", "qty": "0.001", "price": "60000",
  "source": "BAYESSHIELD_GATEWAY", "simulated": false,
  "winProbability": 0.3, "lossProbability": 0.7,
  "warning": "High modeled loss probability",
  "assessedAt": "2026-10-25T07:00:00.000Z"
}
```

This is a proposed **normalization contract requiring vendor agreement**, not
verified BayesShield direct API compatibility. Probabilities must sum to one,
scores must be current and correlated, and configured gateway failures block
paper orders. Missing configuration returns **unknown/null** probabilities,
never fabricated AI outputs. Unknown or >=50% loss probability requires explicit
acknowledgment before every new paper fill. Any AI probability is uncertain;
it cannot bound a conventional leveraged future's realized losses.

`sizeLossBoundedPosition` maps a hypothetical **contractually premium-capped**
product to the ATP loss fraction:
`floor_to_qty_step((principal * maxLossFraction - worstCaseFees) / unitPremium)`.
Budgets round down and losses round up to eight settlement decimals. Inputs
start at zero and must be intentionally supplied. This is scenario math only,
not a certified product quote or an automatic allocation mandate.

### Unified region stream and app

The mobile/responsive app has one **Your wealth** table and **Explore assets**
selector across all regions. It keeps currencies/accounting modes distinct,
labels simulated prices and supports fully funded practice buys/sells. Outside
isolated demo, explicit practice credits remain available. An expandable advanced
calculator explains upfront-cost loss estimates without certifying products.

REST under `/api/v1/perpetuals`: `GET /symbols`, `GET /portfolio`,
`POST /paper/fund`, `POST /paper/orders`, `POST /risk-preview`,
`POST /loss-budget`. All require existing device-bound authentication. Financial
mutations require `Idempotency-Key`; quote/risk calls are read-like previews.

WebSocket: `/api/v1/markets/stream` or channel-filtered
`/api/v1/perpetuals/quotes`, `/api/v1/perpetuals/marks`,
`/api/v1/perpetuals/trades`. Send credentials in the first message, **not a URL**:

```json
{ "op": "auth", "token": "your-access-token", "deviceId": "your-persistent-device-id" }
```

After `{ "type": "authenticated" }`, send either:

```json
{ "op": "subscribe", "region": "GLOBAL", "symbol": "BTCUSDT" }
```

or `{ "op": "subscribe", "region": "LOCAL", "provider": "NGX",
"symbol": "your-licensed-symbol", "range": "1M" }`.
Each socket has one replaceable subscription. Local history remains a
60-second-polled EOD/fixing snapshot with its original unit/frequency; it is not
misrepresented as tick data. Frames contain `type: "market"` and
`event: { region, provider, simulated, symbol, channel, receivedAt, data }`.
Error/status frames explicitly invalidate stale data. Upstream global sockets
reconnect with bounded exponential backoff and fresh subscriptions; book
sequence gaps trigger resync. Book frames are **indicative raw deltas**, not a
reconstructed/CRC32C-certified executable book. Build and verify CRC32C/depth
handling before using these frames for execution/liquidity decisions.

The gateway has a five-second authentication deadline, periodic session
revalidation, same-host browser-origin checks, heartbeat/slow-consumer limits,
a 100-connection per-process ceiling and per-user subscription/request rate
limits. Supply exact trusted-proxy/origin policies at deployment. Cross-replica
fan-out, vendor quotas and shared upstream subscriptions remain scaling gates.
The Vite proxy forwards WebSocket upgrades in development.

## Authentication and privacy

1. Registration requires `Idempotency-Key`, Nigerian phone, password (12-72
   UTF-8 bytes), and BVN or NIN. It returns `registered: true`, not a token.
   KYC and virtual account jobs commit atomically with the account; registration
   no longer hangs or falsely reports that a queued verification is complete.
2. `POST /api/v1/auth/login` verifies the password then returns
   `{ mfaRequired: true, challengeId, expiresIn: 300 }`.
3. `POST /api/v1/auth/verify-otp` accepts `{ challengeId, code }`. Codes expire
   after five minutes, allow five bad attempts, are single-use, and bind to the
   initiating device/IP. Only successful MFA creates a session/token.
4. All authenticated calls carry `X-Device-ID` (persistent random 20-128 character
   device identifier) and the access token. IP/device mismatch returns
   `401 MFA_REQUIRED`: reauthenticate through the same OTP flow. Never change
   the OTP destination from a login request. Logout revokes the server session.

The UI stores its random device identifier in sessionStorage and tokens only in
memory. It does not use invasive hardware fingerprinting. Binding is a replay
mitigation, **not hardware attestation**: malware stealing both token and device
identifier on the same network is outside this guarantee. SMS is vulnerable to
SIM swaps/phishing; production high-risk actions need stronger MFA/passkeys,
fraud monitoring and a reviewed account-recovery process.

Authentication has shared PostgreSQL rate buckets (IP + account/challenge
issuance), not a per-replica in-memory limiter. Production edge/WAF controls are
still needed for unauthenticated volumetric attacks. Express does not trust
forwarded IP headers. Configure an exact trusted-proxy policy only after
validating your deployment topology; otherwise all proxy clients share an IP.

BVN/NIN, phone, email and profile names use AES-256-GCM at rest. Email/phone blind
indexes use keyed HMAC for lookup. Audit events record actor, subject, action and
database time for profile reads, identity access, enrollment and sessions.
Private identifiers/codes are not returned in API errors or normal logs.
Webhook payloads and queued OTPs are encrypted; completed outbox payloads are
cleared. Configure storage/backup encryption, retention and access policies for
remaining operational identifiers, transaction metadata and bank-account data.
Audit history is append-only to normal writers.

Key rotation requires an explicit decrypt/re-encrypt/reindex migration and
session invalidation; simply changing the encryption key makes old data
unreadable. JWT rotation invalidates sessions/tokens and in-flight OTP hashes.
Key versioning/KMS envelope encryption, consent, subject-access/deletion workflow,
DPIA, breach response and legal retention review remain launch gates.

## Financial atomicity and idempotency

- Decimal strings are validated to NGN precision, with 48-digit decimal
  arithmetic. No floating-point arithmetic determines cash journal amounts.
  Paper simulation retains numeric DTO compatibility but calculates in decimal;
  UI charts/formatting may convert values for display only.
- Every financial unit of work uses a serializable interactive transaction.
  Wallet rows and ledger rows are locked `FOR UPDATE` in sorted order.
  Serialization/deadlock conflicts have bounded retries; exhausted retries return
  a conflict, never successful-looking defaults.
- All ledger postings require active wallets, including direct internal journal
  calls. Interest accrual serializes its permanent journal key and accrued-yield
  increment: concurrent retries return the same journal without adding yield
  twice; different amounts or goals with the same key are rejected.
- Deferred PostgreSQL constraints verify balanced, non-empty journals, matching
  currencies, positive lines and cached balances against immutable line history.
  Journal/line updates/deletes are forbidden. Use compensating journals.
  The history-derived cached-balance check is correctness-first and becomes
  expensive for large settlement accounts; profile it and partition/reconcile
  under audited controls before claiming high-throughput capacity.
- Savings lock dates are `timestamptz`; validation and maturity use the database
  clock in UTC, not host timezone. Maturity makes a goal active; there is still
  **no withdrawal/release endpoint** in this phase.
- Registration, savings and ATP POST operations use a database response cache
  scoped to principal/method/path/key with a 24-hour TTL. A different body with
  the same key returns 409. Response caching and side effects commit together.
  Keep the same key across timeout/retry; change it only for a new intention.
- Credential issuance/OTP/logout intentionally do **not** replay cached tokens.
  They use challenge/session state and rate limits instead. There are no PUT
  routes today; future business mutations must use `idempotentMutation`.

## Webhooks, outbox and reconciliation

`POST /api/v1/webhooks/baas` uses `x-baas-signature`; KYC uses
`x-kyc-signature`. Both are lowercase/uppercase hex HMAC-SHA256 of the exact raw
body (optional `sha256=` prefix), with constant-time comparison. The former
`x-kyc-webhook-secret` contract is deliberately removed.

BaaS payload:

```json
{
  "eventId": "provider-event-id",
  "eventType": "DEPOSIT",
  "virtualAccountNumber": "provider-account-number",
  "amount": "1000.00",
  "currency": "NGN",
  "reference": "stable-settlement-reference",
  "occurredAt": "2026-10-24T12:00:00.000Z"
}
```

An event ID and stable settlement reference are mandatory. Signed receipts
commit to an encrypted inbox plus outbox, then return **202 accepted, not
credited**. Permanent event/reference hashes and journal keys outlive the
24-hour HTTP cache, preventing old webhook replay credits. Conflicting payload
replays return 409. KYC terminal callbacks are replay-safe and reject conflicting
terminal states.

The worker uses `FOR UPDATE SKIP LOCKED`. Internal work, journal posting and job
completion commit together. External gateway calls must be idempotent because
a process can die after an external success but before local commit. Retries
back off up to five minutes; ten failures dead-letter and emit an alert.
Inspect `OutboxJob.lastError`, fix the cause, then an authorized operator may
clear `deadAt` and set `availableAt` to database time. Do not delete inbox or
journal keys. Never blindly credit money just to make reconciliation pass.

This is inbound notification reconciliation plus outbound onboarding retries,
not full bank statement/custody reconciliation. Add provider status polling,
daily settlement/statement matching, exception approval and financial-control
reports before launch. Do not activate a transfer workflow without them.

## Emergency read-only mode

`SYSTEM_READ_ONLY_MODE` accepts only `true` or `false`. The `global` database
control row must exist: if missing, financial mutations fail closed with
`SYSTEM_CONTROL_UNAVAILABLE`. Reconciliation jobs pause without exhausting their
retry budget. Restore the row explicitly through an authorized operational
procedure; the application never automatically enables writes.

Set `SYSTEM_READ_ONLY_MODE=true` in every process and redeploy, or instantly
update the shared DB switch with a restricted operator credential:

```sql
UPDATE "SystemControl" SET "readOnly" = true WHERE id = 'global';
```

Postings hold a shared lock on that control row; the update waits for in-flight
transactions before taking effect. New financial postings are rejected, while
login/profile reads remain available. Signed webhook receipts are still safely
queued; worker postings defer without exhausting retries. Set the DB switch
back to false **and** remove the environment flag to resume. No public kill
switch endpoint is exposed.

## Validation and remaining release gates

```sh
npm test
npm run build
# ONLY against an isolated disposable database named *_hardening_test:
npm run db:deploy
npm run test:integration
```

The integration suite exercises actual PostgreSQL concurrent withdrawals,
balanced journal rejection, direct-SQL constraint defenses, signed webhook
replay/reconciliation, read-only behavior, idempotent savings, encrypted
registration, MFA one-time use and device mismatch.

Before real funds: commission independent security/financial audits, certify
gateway contracts with each partner, implement full bank/custody reconciliation,
strong MFA/recovery, key management/rotation, verified contact changes,
consent/privacy policies, regulatory and licensing review, monitoring and
on-call alerts, encrypted backups with restore drills, disaster recovery and
load testing. Restrict the runtime DB role from DDL, protect audit retention,
and publish incident/recovery runbooks. This code is not a substitute for those
operational and regulatory requirements.
