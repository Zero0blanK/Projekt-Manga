# @projekt-manga/server

The Express API and the only workspace that talks to the database. Everything the web app,
the Electron renderer and the desktop sync runner read or write goes through here.

## Boundary

Prisma lives **only** here. `apps/web`, the Electron renderer and `packages/*` never import
`@prisma/client`; database access stays in server repositories.

## Layering

```text
route → controller → service → repository → prisma
```

Each layer may call the next and no further. Routes validate with Zod schemas from
`packages/schemas`; controllers translate HTTP to and from services; services hold the
business rules; repositories are the only place queries are written.

```text
src/
  routes/        URL → controller, plus per-route validation and rate limits
  controllers/   HTTP in, HTTP out — no business logic
  services/      business rules, transactions, cross-domain orchestration
  repositories/  Prisma queries, one module per table group
  middleware/    auth, error translation, request-scoped concerns
  workers/       background work (the download queue)
  configs/       env validation, the Prisma client, startup migration
  utils/         shared helpers (SSRF guard, error types, response envelope)
```

## The database

SQLite, through `@prisma/adapter-libsql`. `DATABASE_URL` is a `file:` URL and there is no
database server to run — the first migration creates the file. Two behaviours differ from a
server database and have caused real bugs; both are covered in the architecture rules:
`createMany({ skipDuplicates })` is unsupported, and text comparison is case-sensitive.

## Per-account state

Every service that touches user state takes an **optional `user_id` as its last parameter**
and branches: present means the `user_*` overlay tables, absent means the original anonymous
path through the shared tables. Adding a per-account read or write means adding a branch,
never changing the anonymous one.

## Commands

```bash
npm run dev --workspace=@projekt-manga/server        # tsx watch on :4000
npm run build --workspace=@projekt-manga/server
npm run typecheck --workspace=@projekt-manga/server
npm run test --workspace=@projekt-manga/server       # Prisma mocked, no database needed
npm run db:migrate --workspace=@projekt-manga/server # create a migration from schema edits
npm run db:deploy --workspace=@projekt-manga/server  # apply pending migrations
```

## Trusted extension repositories

To authenticate extension publishers, set `EXTENSION_REPOSITORY_TRUST_KEYS` to the JSON map
of exact repository index URLs and Ed25519 public keys described in
[`docs/extension-repository.md`](../../docs/extension-repository.md). These are public keys,
but the private signing keys must remain with the repository maintainers. Repositories not
listed in the setting remain checksum-verified only and are not authenticated.

Integration tests run against a real SQLite file and truncate every table, so they refuse to
start unless `DATABASE_URL` names a disposable database — see
the project's verification guidance.

## Built-in extension engine

**Settings › Extensions › Extension engine** can run Suwayomi-Server (MPL-2.0) for you,
instead of pointing at one you host yourself. Nothing is bundled. The server downloads a Java
runtime (Temurin 21) and the pinned Suwayomi-Server jar only when someone presses Download,
checks each file's SHA-256, and keeps them in `suwayomi-engine/` beside the database. The code
is in `src/services/suwayomi/engine/`.

On a hosted server or in a container:

- **Linux builds are picked automatically**, glibc or musl (Alpine), x64 or arm64. The server
  needs outbound HTTPS to `api.github.com`, `github.com`, the GitHub release-asset hosts and
  `api.adoptium.net`, and a system `tar`.
- **Disk:** about 235 MB to download and about 350 MB once unpacked, plus whatever extensions
  are installed. If the database lives on a volume, so does the engine; otherwise it is
  downloaded again whenever the container is recreated.
- **Memory:** the Java heap defaults to 512 MB and can be set between 256 and 8192 MB in the
  same panel. Leave that much headroom in the container's memory limit.
- **Network:** the engine listens only on `127.0.0.1` on a free port, with a generated login,
  so it is never reachable from outside the container. Its web UI, tray icon, update checks,
  automatic backups and embedded browser are turned off.
- It starts with the server when chosen, restarts up to three times after a crash, and stops
  with the server (its whole process tree).

## API reference

- [`API.md`](API.md) — human-readable index with `curl` examples
- [`openapi.yaml`](openapi.yaml) — formal spec, the source of truth for request/response shapes
- [`../../docs/api/`](../../docs/api/) — per-domain reference including the TypeScript shapes
