# Instanta (Phase 1 foundation)

Node.js 20.19+, 22.12+, or 24+, TypeScript, Express, PostgreSQL, and Prisma 7 foundation for the Instanta MVP.

See [PRODUCTION_README.md](./PRODUCTION_README.md) for the hardening upgrade,
MFA, encrypted-profile migration, required secrets, partner gateway contracts,
worker operations and remaining production release gates.

## Setup

1. Install Docker with Compose v2 and start its daemon (Docker Desktop on macOS).
2. Copy `.env.example` to `.env`. Set a local `POSTGRES_PASSWORD` and the same password in `DATABASE_URL` (URL-encode special characters in the URL). Set independent random secrets for JWT, PII encryption, and webhooks.
3. Install dependencies with `npm install`.
4. If upgrading existing profiles, run `npm run db:prepare` and `npm run pii:migrate` once first.
5. Run `npm run dev`. Startup validates the local connection configuration, starts PostgreSQL in Docker, waits for its health check, generates the Prisma client, applies committed migrations, then starts the API, background worker and React at **http://127.0.0.1:5173**. Setup failures stop startup instead of launching against an unready database.

The product landing page is `/`; open `/app` for the dashboard. Registration
now queues partner onboarding and then requires sign-in plus a one-time code
before issuing a device-bound token. Development mock OTPs appear only in the
private worker console; mock KYC accepts BVN/NIN `00000000000`.

### Local database lifecycle

PostgreSQL 17 runs through `compose.yaml`, with its host port bound to loopback
only. Data persists in the Compose project's `postgres_data` named volume.
The API and UI still run on your host for fast hot reload.

- `npm run db:prepare`: start/wait for PostgreSQL, generate client, deploy migrations.
- `npm run db:up`: start/wait for the database only.
- `npm run db:stop`: stop PostgreSQL without removing data.
- `npm run db:down`: remove Compose containers/network, retaining the data volume.
- `npm run db:logs`: follow PostgreSQL logs.
- `npm run db:adminer`: start the development database viewer at **http://localhost:8080**.
- `npm run start:local`: prepare the database, build, and serve the built UI/API.

Ctrl+C stops the development API/UI, but leaves the database running; stop it
explicitly with `db:stop`. Do not use `docker compose down --volumes` unless you
intend to permanently delete your local data.

If port 5432 is occupied, change `POSTGRES_PORT` and the port in `DATABASE_URL`
together. PostgreSQL initialization variables apply only to an empty volume;
changing passwords or database names later requires updating the existing
database, not merely editing `.env`.

If upgrading an existing `.env`, add the `POSTGRES_*` settings and align its
`DATABASE_URL` before running `dev`. The startup script does not overwrite it.
For an already managed/external database, run `db:generate`, `db:deploy`, then
`dev:services` to skip Docker. `npm start` also does not start Docker or run
migrations, so production database management stays explicit.

The committed baseline migration initializes an empty database. For an existing
database created outside Prisma Migrate, verify it matches `schema.prisma` and
baseline it using Prisma's migration baselining procedure before deploying
migrations; do not reset a database containing real data.

## User interface

The responsive React dashboard lives in `web/` in this same project. It includes
an overview, wallet funding details and ledger activity, savings goal creation,
a simple yield estimator, an ATP floor/drift simulator, Nigerian market charts,
and identity/risk-budget details. The header's **Back to website** link and logo
return to the public landing page.

- **Demo** now requires the API and a separate PostgreSQL database. It starts
  with NGN 5,000,000 and USD 10,000 in virtual funds, credited once per demo
  identity. Savings, trades, plans and rebalancing persist locally. No external
  provider is contacted, even when credentials are configured. The persistent
  banner says **Demo Mode — Simulated Live Environment**. This replaces the
  old empty, browser-only demo; real account records are never changed.
- **Live API** offers registration/login and reads real authenticated account data.
  Goal creation and ATP evaluations use the existing API. API/provider errors stay
  visible; the UI never silently substitutes demo data. Bearer tokens are kept in
  memory and discarded on refresh, sign-out, or switching modes.
- BVN/NIN are sent only during live registration; the dashboard endpoint returns
  last-four values, never encrypted identifiers or password hashes.
- Funding details depend on partner-assigned virtual accounts. There are no
  client-side webhook simulators or unauthenticated deposit controls.
- Auto-sweep is a stored preference, not a running scheduler. The yield estimator
  does not post interest, and the ATP simulator does not execute trades.
- **Explore assets** includes NGX equities/ETFs (historical daily closes) and
  a licensed FMDQ connector for Treasury bills/NITTY, FGN bonds and macro rates.
  Market data requires Live API sign-in and server-side subscription configuration;
  missing data displays an explicit empty/error state, never sample prices.
  See the market-data setup in the production guide. Existing real ledger
  balances/history are not reset by demo mode.
- Global products appear beside Nigerian products in one selector, without a
  Local/Global switch. Outside demo, USD, USDT and USDC practice balances start
  at zero. Explicit simulated
  credits, fully funded spot/security buys and sells, position cost basis and
  activity use a separate eight-decimal double-entry book. Perpetuals/barriers
  are view/scenario-only, not represented as margin-free or guaranteed.
  Real-money orders, custody and NGN/global FX are disabled. See the production
  guide for venue keys, WebSocket contracts and the BayesShield gateway boundary.

**Your wealth** is one expandable table for cash, savings, holdings and saved
plans. Rows explain interest, locks, target differences and recent activity.
Totals stay separate by currency and accounting mode; unfunded plans are not
counted as investments. Holding amounts are purchase costs, not current prices.
The sign-in form now includes **Forgot password?** for code-based recovery.

`npm run dev:web` starts only the frontend. Both account and demo workflows need
the API and database. Its development proxy expects the API at `127.0.0.1:3000`;
if changing the API port, update `web/vite.config.mts` accordingly.
`npm run dev:api` starts only the backend; run `npm run worker` separately when
not using the combined development command.

Run `npm run build` for both production builds, then `npm start`. Express serves
the built UI at **http://localhost:3000/** alongside `/api/v1`. Run `npm test` for
the calculator, validation and HTTP boundary tests (no database required).

### Isolated funded demo

Copy `.env.example` to a private `.env.demo` (already ignored). Set fresh local
secrets, `IS_DEMO_MODE=true`, `POSTGRES_DB=instanta_demo`, `POSTGRES_PORT=5433`,
and a matching `DATABASE_URL` ending in `/instanta_demo?schema=public`. Keep the
password in both settings consistent. Never reuse customer data or production keys.

```sh
DOTENV_CONFIG_PATH=.env.demo COMPOSE_ENV_FILES=.env.demo COMPOSE_PROJECT_NAME=instanta-demo npm run dev
```

The separate Compose project and port isolate both the volume and database.
Stop an existing API/UI before using the same application ports. Open
`/app?mode=demo`. Refresh preserves the same tab's progress. Clearing tab storage
creates a new fictional identity, not a refill of the previous account.
Demo refuses production, non-demo database names and databases with real-mode
accounts. Missing isolation produces an error, not a fallback. The read-only
kill switch still applies. Runtime needs PostgreSQL, but no provider account
or internet connection.

### Development database viewer

Run `npm run db:adminer`; open **http://localhost:8080**. Select PostgreSQL,
server `db`, and your local `POSTGRES_USER`, `POSTGRES_PASSWORD`, `POSTGRES_DB`.
For demo, use the same `.env.demo`/Compose environment prefix shown above.
Adminer is an opt-in `tools` profile in the existing `compose.yaml`, bound only
to loopback. Never expose it publicly or deploy it in production.
It has direct database privileges: do not edit balances or immutable history.

Prisma CLI connection settings live in `prisma.config.ts`, which loads `.env`.
The application uses `@prisma/adapter-pg` with the same `DATABASE_URL` and a
five-second connection timeout. Keep `prisma`, `@prisma/client`, and
`@prisma/adapter-pg` on the same version; regenerate the client after upgrades.
The existing `prisma-client-js` generator is retained to preserve the backend's
CommonJS build and `@prisma/client` imports.

The BaaS settlement account is provisioned at registration. Named partner
adapters target certified normalization gateways configured with `*_GATEWAY_URL`
and `*_API_KEY`; see the production guide. Production fails closed without
live credentials. A configured BaaS partner must assign a unique
`Wallet.virtualAccountNumber` before sending settlement notifications.

## Endpoints

- `POST /api/v1/auth/register` — idempotently creates an encrypted profile, wallet and queued onboarding jobs.
- `POST /api/v1/auth/login` — verifies password and creates a device-bound OTP challenge.
- `POST /api/v1/auth/verify-otp` — consumes a valid code and issues an access token.
- `POST /api/v1/auth/logout` — revokes the session.
- `POST /api/v1/auth/forgot-password` — accepts `{contact}` (email or Nigerian phone); returns a generic message and challenge ID.
- `POST /api/v1/auth/verify-recovery-otp` — accepts `{challengeId, code}`; returns a short-lived device-bound reset token.
- `POST /api/v1/auth/reset-password` — accepts `{resetToken, password}`; changes the password and revokes all sessions.
- `GET /api/v1/wealth/products` — unified Nigerian/global selector with explicit per-source availability errors.
- `GET /api/v1/wealth/summary` — consistent cash, goal, holding and plan table with separate currency/mode totals.
- `GET /api/v1/demo/config`, `POST /api/v1/demo/session` — discover and open an isolated demo.
- `POST /api/v1/demo/rebalance` — idempotent, database-local equal-weight demo adjustment within each currency.
- `GET /api/v1/dashboard` — bearer-authenticated, consistent snapshot of the user's masked profile, wallet, goals, and latest 50 ledger lines.
- `POST /api/v1/savings/goals` — bearer-authenticated savings goal creation and optional initial lock.
- `POST /api/v1/atp/shadow-evaluate` — bearer-authenticated floor and portfolio drift evaluation; stores a historical evaluation.
- `POST /api/v1/webhooks/baas` — verifies HMAC `x-baas-signature`, stores a durable receipt and returns 202; the worker posts an idempotent journal.
- `POST /api/v1/webhooks/kyc` — accepts terminal status callbacks authenticated with HMAC `x-kyc-signature`.

Registration, goal creation and ATP evaluation require an `Idempotency-Key`.
Authenticated calls also require `X-Device-ID` plus the access token.

All API responses use `{ "success": true, "data": ... }` or `{ "success": false, "error": { "code": "...", "message": "..." } }`.

## Money and risk conventions

Amounts are NGN decimal strings with at most two decimal places. Ledger journals reject unbalanced lines and update account normal-balance totals atomically under PostgreSQL serializable isolation. BVN/NIN values are AES-256-GCM encrypted at rest; only last-four values are retained separately. The ATP `maxLossPercent` is expressed from 0 to 100, `riskFreeRate` is an annual decimal, and `timeHorizonYears` is in years. The T-bill estimate discounts the maturity floor using simple yield and is a simulation, not a guarantee of investment performance.

Before production, add provider-specific virtual-account provisioning, operational monitoring/reconciliation, rate limiting, key rotation, and a full authorization/consent policy. Do not expose the provider integration endpoints publicly without validating the provider's actual signing and identity contracts.

The demo and live ATP calculators share pure domain logic. Portfolio holdings
must sum to the declared total; once the drift threshold is crossed, suggested
paper trades include offsetting legs so buys and sells balance.
