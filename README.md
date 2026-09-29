# Electronics Retail Management System — Backend

NestJS + Prisma + **MySQL 8 (InnoDB)** backend for an **Electronics Retail Management System** (products tracked by IMEI, serial, or quantity). *(Repo folder is `PhoneStoreERP` for path stability.)*

Design of record: [`../docs/06_TECHNICAL_ARCHITECTURE.md`](../docs/06_TECHNICAL_ARCHITECTURE.md) · [`../docs/10_DATABASE_SCHEMA.md`](../docs/10_DATABASE_SCHEMA.md) · [`../docs/15_SECURITY_ARCHITECTURE.md`](../docs/15_SECURITY_ARCHITECTURE.md)

## Stack
Flutter client (later) → **NestJS 10** REST API (`/api/v1`) → **Prisma** → **MySQL 8**. Argon2id hashing, JWT + rotating refresh tokens, structured pino logging, app-layer multi-tenancy.

## Project layout
```
src/
├── main.ts app.module.ts        # bootstrap + composition root
├── common/
│   ├── config/                  # env (Joi-validated) + typed AppConfigService
│   ├── context/                 # AsyncLocalStorage store (requestId/userId/companyId/branchId/permissions)
│   ├── decorators/              # @Public @CurrentUser @BranchId
│   ├── filters/                 # AllExceptionsFilter (problem+json, Prisma mapping)
│   ├── interceptors/            # BinaryUuidInterceptor (BINARY(16) -> uuid string)
│   ├── security/                # HashingService (Argon2id)
│   └── utils/                   # uuid (v7 <-> binary), duration
├── prisma/                      # PrismaService (system) + fail-closed tenant extension (TENANT_PRISMA)
├── auth/                        # login/refresh/logout/me, JWT + refresh sessions, JwtAuthGuard
├── rbac/                        # AccessService + PermissionsGuard + @RequirePermissions
├── users/                       # user management foundation
├── storage/                     # StorageProvider iface + LocalDiskStorage
├── notifications/               # NotificationChannel iface + in-app channel + service/controller
└── health/                      # GET /api/health (DB ping)
prisma/                          # schema, migrations (0001..0003), seed  (see below)
```

## Security model (summary — full detail in docs/15)
- **Tenant isolation is app-layer, fail-closed** (MySQL has no RLS): the JWT sets `companyId` into request CLS; the **Prisma tenant extension** injects `company_id` into every tenant query and **throws** if a tenant query runs with no context. Reads/updates are auto-scoped; tenant **creates** pass `companyId` from context explicitly.
- **AuthN**: Argon2id passwords; short-lived JWT access token; opaque **rotating** refresh token (`<sessionId>.<secret>`, only the Argon2 hash stored in `auth_sessions`); reuse revokes the session.
- **AuthZ**: `@RequirePermissions('x')` + `PermissionsGuard`; permissions resolved per branch from `user_branches → role_permissions`.
- **DB users**: `phonestore_migrator` (migrations) vs `phonestore_app` (runtime, DML only, append-only `audit_logs`). The API runs as `phonestore_app` via `APP_DATABASE_URL`.
- Global: helmet, CORS allowlist, rate limiting (tighter on `/auth/*`), strict validation, consistent error bodies with request ids.

## API (Sprint 1)
| Method | Path | Auth | Notes |
|---|---|---|---|
| GET | `/api/health` | public | DB connectivity |
| POST | `/api/v1/auth/login` | public | → access + refresh tokens |
| POST | `/api/v1/auth/refresh` | public | rotates the refresh token |
| POST | `/api/v1/auth/logout` | bearer | revoke current session |
| POST | `/api/v1/auth/logout-all` | bearer | revoke all sessions |
| GET | `/api/v1/auth/me` | bearer | current user |
| GET | `/api/v1/auth/permissions` | bearer | effective permissions (`X-Branch-Id` optional) |
| GET | `/api/v1/notifications` | bearer | own + broadcast |
| POST | `/api/v1/notifications/{id}/read` | bearer | mark read |

Swagger UI at `/docs`, OpenAPI JSON at `/docs-json`.

## Database setup (MySQL 8.0+; WAMP is one local option)
```bash
cd backend
cp .env.example .env
mysql -h 127.0.0.1 -P 3306 -u root < prisma/sql/init/00_roles.sql        # users + grants (once)
npm install
npm run migrate:deploy                                                    # 0001..0003
mysql -h 127.0.0.1 -P 3306 -u root < prisma/sql/init/10_audit_append_only.sql  # audit triggers (once)
npm run seed                                                              # 17 perms, 5 roles, demo owner
```

## Run & test
```bash
npm run start:dev      # watch mode
npm run build          # nest build
npm test               # jest unit suite
```
- Default `PORT=3010` in `.env` (3000 is taken by another local dev app on this machine — change freely).
- Seeded login: `owner` / `OWNER_SEED_PASSWORD`.

## A QA dataset (a disposable database, never live)
`npm run qa:seed` provisions ten test boutiques — `boutique1@test.com` … `boutique10@test.com`, each its own company with
one branch, one Owner and 100 items (80 phones with IMEIs, 20 barcoded accessories) — and the platform administrator
`admin@test.com`, all eleven with the one password in `QA_PASSWORD`. It writes through the real API, which it starts
privately on loopback, and refuses any database not named `prisma_qa` / `prisma_qa_<suffix>`, a production or staging
environment, a server whose `sql_mode` has `ONLY_FULL_GROUP_BY` (live runs with `sql_mode=''`), unapplied migrations,
and — on its first run — a database that already holds businesses. Details: `scripts/qa-boutiques.ts`.
```bash
# 1. The database, as the migrator (its prisma\_% grant covers it) or as root
mysql -h 127.0.0.1 -P 3306 -u phonestore_migrator -p \
  -e "CREATE DATABASE prisma_qa CHARACTER SET utf8mb4 COLLATE utf8mb4_0900_ai_ci"
# 2. Its schema
DATABASE_URL="mysql://phonestore_migrator:<password>@127.0.0.1:3306/prisma_qa" npx prisma migrate deploy
# 3. The dataset
export QA_DATABASE_URL="mysql://phonestore_migrator:<password>@127.0.0.1:3306/prisma_qa"
export QA_PASSWORD='<the QA-only password>'
npm run qa:seed                  # checks and reports; writes nothing
npm run qa:seed -- --apply       # provisions; a rerun adds nothing and finishes a run that stopped
npm run qa:seed -- --verify      # 95 checks, through the API and in the database
```
- PowerShell: `$env:QA_DATABASE_URL = "…"; $env:QA_PASSWORD = "…"` instead of `export`.
- Without `QA_DATABASE_URL`, the server and credentials come from `.env`'s `DATABASE_URL` and the database from `QA_DB`
  (default `prisma_qa`).
- A rerun gives a tester-changed fixture password back its QA value; sold or moved stock is not restored — for a
  fresh dataset, drop and recreate the database. `--verify` checks the dataset as seeded.

## Notes
- **Ids**: UUIDv7 stored as `BINARY(16)`, generated app-side; the API always emits/accepts canonical UUID strings.
- **Money**: `DECIMAL(14,2)`. **Timestamps**: `DATETIME(6)` UTC.
- MySQL-specific schema details (generated columns, FULLTEXT, CHECK limitations, append-only triggers) are documented in `../docs/10_DATABASE_SCHEMA.md`.
- **No business logic yet** — feature modules (inventory, sales, dashboard, …) are future sprints and build on this foundation.
