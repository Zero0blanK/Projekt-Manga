# @projekt-manga/desktop

The Electron shell. It renders `apps/web` in a hardened window, adds the OS-level
capabilities a browser cannot provide, and — in a packaged build — supervises the API and
web server as child processes.

## Layout

```text
src/
  main/        the privileged process: window, IPC handlers, supervisor, local DB, sync
  preload/     the only bridge to the renderer, sandboxed; exposes exactly `window.desktop`
  shared/      constants both main and preload need (IPC channel names, URLs)
```

`main/` and `preload/` are compiled as independent entry points and run in different
contexts, which is why anything they share lives in `shared/` rather than being imported
across.

## Two modes

**Development** — Electron is only a window. You start the API and web app yourself
(`npm run dev:server`, `npm run dev:web`), and this loads `http://localhost:3000`.

**Packaged** — the main process becomes a supervisor (`main/servers.ts`): it picks two free
ports, spawns the API and the web server using Electron's own Node
(`ELECTRON_RUN_AS_NODE`), and loads `http://projektmanga.localhost:<port>`. Supervision is
on when packaged and off in development; `PROJEKT_MANGA_MANAGED_SERVERS` forces either.

`*.localhost` resolves to loopback in browsers by RFC 6761, with no hosts-file edit — but
**not** through the Windows OS resolver, so a `curl`/`Test-NetConnection` against it failing
is expected and does not mean the app is broken.

## The preload bridge

`preload/index.ts` runs sandboxed and can only `require` Electron and a small built-in
allowlist — it **cannot resolve relative imports**. An import of `../shared/config` there
once made `contextBridge.exposeInMainWorld` silently never run, leaving `window.desktop`
undefined with no error anywhere. Channel names are duplicated as literals for that reason
and must stay in sync with `shared/config.ts`.

Anything the renderer needs from the OS goes through this bridge. `apps/web` must keep
working with `window.desktop` absent, so every consumer probes for it first.

## Local database

`main/db/` is a local-first SQLite cache using Node's built-in `node:sqlite`, **not**
`better-sqlite3` — the latter's native addon cannot be compiled on this project's Windows
toolchain, and `node:sqlite` ships inside Electron with no packaging risk. `db/migrate.ts`
holds the migration runner; read its comments before adding a migration, particularly the
one about `PRAGMA foreign_keys` being a no-op inside a transaction.

Local catalog and reading state are now stored separately for each signed-in account and
for anonymous use. The older `local.db` could contain a mix of both; it is preserved in
Electron's user-data directory for manual recovery, but is not opened automatically so
signing out cannot expose a previous account's cached history. On first use, the app
seeds the new account cache from the authenticated server. Unsynced changes that exist
only in the legacy file require a deliberate, account-verified recovery.

## Building an installer

```bash
npm run build --workspace=@projekt-manga/desktop     # tsc only
npm run package --workspace=@projekt-manga/desktop   # build → stage → electron-builder
```

For an isolated validation build, `npm run stage --workspace=@projekt-manga/desktop --
--out-dir staging-review` stages into a new directory inside `apps/desktop`. It refuses an
existing destination. Point the validation Electron Builder config's `extraResources` paths at
that directory and use `--publish never` when packaging local checks.

`scripts/stage-installer.mjs` is not optional plumbing: npm workspaces hoist dependencies to
the repo root, so `apps/server` and `apps/web` have almost empty `node_modules` of their own.
Staging installs real production trees outside the workspace, writes the Prisma config the
packaged server needs, and builds the web app in single-origin mode. Packaging the app
directories directly produces an installer that cannot start.

The installer ships **no bundled manga sources** — users add a source repository at runtime.
See [`../../docs/extension-repository.md`](../../docs/extension-repository.md).

## Local CBZ comics

The library's **Local comics** link opens `/local`. Import a user-selected CBZ through the
native file picker, then read its pages or remove the managed copy. The original CBZ is
never modified. Archives are isolated by the current desktop account or anonymous profile,
and the renderer receives opaque IDs and image bytes rather than filesystem paths.

The importer accepts JPEG, PNG and WebP pages, at most 100 MiB compressed, 500 MiB expanded,
2,000 pages and 32 MiB per image. Pages are limited to 16 megapixels and 16,384 pixels per dimension
before decoding, using [image-size's header reader](https://github.com/image-size/image-size#passing-in-a-bufferuint8array).
Encrypted archives, links, unsafe paths and other file
entries are rejected. It uses [yauzl's lazy entry processing and entry-size validation](https://github.com/thejoshwolfe/yauzl#openpath-options-callback)
and checks actual expanded bytes while writing each page. A failed import removes its
verified temporary directory; an interrupted process can leave an ignored `.partial-*`
directory. Page requests remain within the active profile's managed archive directory.

Local files are excluded from backups and account sync. Page position remains device-local
and travels only as a preference in settings backups. The local reader reuses the paged
reader with a bounded image window; source extensions and server library rows are not used.
