# Contributing to Projekt Manga

This doc covers getting the project running locally, the checks to run before opening a
PR, and how to write a manga source.

## Project layout

This is an npm-workspaces monorepo:

```text
apps/web              Next.js 16 App Router + React 19 — also the desktop app's UI
apps/server           Express + Prisma + SQLite API
apps/desktop          Electron main process, preload, local cache and installer
apps/extensions       The sandbox that runs installed sources, plus shared scraping
                      and anti-detection infrastructure
packages/types        Shared TypeScript types, no runtime deps
packages/schemas      Zod validation schemas (built on packages/types)
packages/api-client   The only place the web app calls the API from
```

Dependencies flow one way: `types` → `schemas` → `api-client` → apps. Packages never
import apps.

`packages/*` are compiled to `dist/` and consumed from there, so editing a
`packages/*/src/*.ts` file changes nothing until it is rebuilt. The workspace scripts
handle this for you (their `pre*` hooks rebuild the packages
they depend on). It only bites if you run `npx tsc` directly inside a workspace
instead of `npm run <script> --workspace=<name>`.

No manga sources ship with the app. Sources are installed at runtime from an extension
repository and each one runs in its own sandboxed process — see
[Writing a manga source](#writing-a-manga-source).

## Prerequisites

- **Node.js 25 or newer.** Not a preference: the source sandbox refuses to start below it,
  because earlier versions don't gate network access under `--permission` (see
  `assertNodeSupportsNetworkPermission` in `apps/extensions/sandbox/spawnSandboxedSource.ts`).
  `.nvmrc` pins it.
- npm 10+ (workspaces support).
- No database server. The API uses SQLite — one file, created by the first migration.

## Setup

```bash
git clone https://github.com/Zero0blanK/Projekt-Manga.git
cd Projekt-Manga
npm install
cp apps/server/.env.example apps/server/.env
npm run db:migrate --workspace=@projekt-manga/server
```

The defaults in `apps/server/.env` work as-is: `DATABASE_URL` points at
`file:./data/projektmanga.db`, and the directory and file are created by the migration.
Read the comment above a block before changing it — several exist to avoid surprising
behaviour (for example `CLIENT_URL`, which has to share a registrable domain with wherever
the web app is served from). The settings you are most likely to need:

| Variable                          | What it is for                                                        |
| --------------------------------- | --------------------------------------------------------------------- |
| `ADMIN_TOKEN`                     | Restricts host-level routes when set (see below). Unset by default    |
| `TRUST_PROXY`                     | Which proxies to trust for the client address. Defaults to `loopback` |
| `EXTENSION_REPOSITORY_TRUST_KEYS` | Public keys for signed extension repositories                         |

The web app reads `NEXT_PUBLIC_API_URL`; copy `apps/web/.env.example` to
`apps/web/.env.local` only if the API isn't on the default `http://localhost:4000/api`.

Run the API and web app:

```bash
npm run dev:server   # API on :4000
npm run dev:web      # web app on :3000, in a second terminal
```

Or start the API, the web app and the Electron shell together (Electron waits for the web
server before launching):

```bash
npm run dev:desktop:all
```

Then open the app, go to **Discover → Extensions** and add a source repository.

### Host-level routes

Some routes act on the machine the server runs on rather than on an account: the
downloads directory, installing and removing extensions, and backup restore. By default
any client can use them. Setting `ADMIN_TOKEN` (16+ characters) restricts them to the
server host itself (loopback) and to requests that send the `X-Admin-Token` header with
that value; anything else gets a 403. The web app doesn't send the header, so with a token
set those screens only work from a browser on the server machine or the desktop app. If
you put the server behind a reverse proxy, set `TRUST_PROXY` so the real client address is
used.

## Before opening a PR

Run the checks for what you touched:

```bash
npm run typecheck --workspace=<each workspace you touched>
npm run test --workspace=ProjektManga                 # apps/web
npm run test --workspace=@projekt-manga/server        # apps/server (Prisma is mocked)
npm run test --workspace=@projekt-manga/extensions    # sandbox and scraping infrastructure
npm run test --workspace=@projekt-manga/desktop       # Electron main process
npm run build:web                                     # if apps/web changed
npm run lint
npm run format:check
```

`npm run typecheck` and `npm test` from the root run every workspace. For an end-to-end
pass, `npm run smoke -- browser` drives the web app against a fixture API.

### Integration tests

`npm run test:integration --workspace=@projekt-manga/server` runs against a real SQLite
database and **truncates every table**. Point `DATABASE_URL` at a disposable database
whose name contains `test` or `ci`, with migrations already applied —
`tests/integration/setup.ts` refuses to run otherwise. Never run it against your own
library database.

### Visible changes

If your change affects visible behaviour, run the app and exercise it. A green typecheck
or test suite proves what is tested, not that the feature works. Do this against a
disposable database and, for the desktop app, a throwaway user-data directory.

### Schema and API changes

Don't add a database table, column, enum value or API endpoint without discussing it
first in an issue or the PR description: say what is missing, why the feature needs it,
and what the change would cost. A lot of "we need a new column" turns out to be reachable
from existing data.

## Conventions

- **Workspace boundaries.** `apps/web` must work without `window.desktop` and never
  touches a database. Database access in `apps/server` stays in its repositories. HTTP
  calls from the UI go through `packages/api-client`.
- **Shared contracts.** A type shared between web and server goes in `packages/types`,
  its validation in `packages/schemas`, the call in `packages/api-client`.
- **Untrusted input.** Validate request bodies, params and IPC arguments at the server
  and privileged IPC boundaries. Keep errors safe to show and never echo secrets.
- **Account model.** The app works signed out. Preserve anonymous use, per-account
  overlays on shared rows, nullable manga relationships and shadow rows (a manga row that
  exists for reading or downloading but isn't in the library).
- **Next.js.** The web app runs a Next.js version newer than most references describe.
  Read the matching guide in `apps/web/node_modules/next/dist/docs/` before changing
  framework-specific code.
- **Comments** explain why, not what. Match the surrounding code's naming and style.

---

### What runs where

The server starts one child process per installed source under `--permission`, with no
network access and a filesystem allowlist limited to its own bundle directory
(`apps/extensions/sandbox/`). In practice:

- **Use `fetch`, and only `fetch`.** It is proxied through the server, which checks every
  request — and every redirect hop — against the source's `allowed_hosts` and the SSRF
  guard. `axios`, `node:https` and anything else that opens its own socket will fail.
- **Request bodies must be strings.** Other body types arrive as `null`.
- **Bundle every dependency** into the single file (10 MB cap). Pure-JS parsers such as
  cheerio are fine; browser automation is not available inside the sandbox.
- Only the methods in the contract above can be called.

### Errors

Never fail silently or return a fake empty result. Throw a `SourceError` with one of the
`SourceErrorCode` values (`NETWORK_ERROR`, `TIMEOUT`, `NOT_FOUND`, `BLOCKED`,
`RATE_LIMITED`, `PARSE_ERROR`, `UPSTREAM_ERROR`). The server maps each code to an HTTP
status and a message the UI can show — "this source is blocking us" rather than an empty
page. See `apps/extensions/sourceError.ts`.

### Trying it locally

The server only fetches repository and bundle URLs that resolve to a public address, so
`http://localhost` is rejected by design. Serve your files through a tunnel, or push to a
branch and use its raw URL — both are described in the guide's development-loop section.
When adding an unsigned repository's source, the app asks you to confirm the install,
because its bundle can't be authenticated.

### Changing the sandbox itself

Work on the sandbox or the shared scraping and anti-detection code
(`apps/extensions/features/`, `apps/extensions/utils/`) lives in this repository:

```bash
npm run test --workspace=@projekt-manga/extensions
npm run build --workspace=@projekt-manga/extensions
```

`npm run dev:server` does not rebuild `apps/extensions`, so rebuild it before checking a
change through a running server. Don't weaken the sandbox's network restrictions.
