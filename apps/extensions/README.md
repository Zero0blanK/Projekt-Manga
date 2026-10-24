# @projekt-manga/extensions

The sandbox that runs installed manga sources, plus the scraping and anti-detection
infrastructure that sits beside it.

No sources live in this workspace. Every source is installed at runtime from an extension
repository and runs in its own restricted child process. To write one, see
[`docs/extension-repository.md`](../../docs/extension-repository.md).

## Entry points

`package.json` exposes two, on purpose:

| Import                              | What it is                                                   | Used by                                 |
| ----------------------------------- | ------------------------------------------------------------ | --------------------------------------- |
| `@projekt-manga/extensions/sandbox` | `spawnSandboxedSource()` and its types                       | `apps/server`'s extension services      |
| `@projekt-manga/extensions`         | The sandbox, plus anti-detection stats and the scraper cache | `apps/server`'s health route, on demand |

The root entry pulls in puppeteer and playwright at import time. The sandbox needs
neither, and a sandboxed source couldn't use them anyway, so the server imports the
`./sandbox` subpath everywhere except the health route. That is what lets the desktop
installer ship without a browser stack.

## The sandbox (`sandbox/`)

`spawnSandboxedSource()` starts one Node child per installed source and returns a `Source`
whose methods are forwarded to it over IPC.

- **Permissions.** The child runs under `--permission` with no network grant, no child
  processes, and read access limited to its own bundle directory. Node 25 or newer is
  required: earlier versions don't gate network access under `--permission`, so
  `assertNodeSupportsNetworkPermission` refuses to start rather than pretend.
- **Network.** `runner.ts` replaces the child's global `fetch` with a shim that sends each
  request to the parent. The parent checks the URL against the source's `allowed_hosts`
  and the SSRF guard, follows redirects itself (re-checking every hop), and performs the
  request with the `fetchImpl` the caller supplied. The server passes a fetch that also
  checks the resolved address at connect time, so a host can't pass validation and then
  resolve to a private address.
- **Calls.** Only the `Source` methods listed in `ALLOWED_METHODS` (`runner.ts`) can be
  invoked. The bundle must be an ES module whose default export has a `fetchManga`
  function.
- **Pacing.** `mangadexPacing.ts` spaces requests to MangaDex hosts across every sandbox
  in the same parent, to stay inside its published rate limits.

Don't weaken any of these restrictions to make a source work; fix the source instead.

## Scraping and anti-detection (`features/`, `utils/`, `config/`)

- `features/Orchestrator.ts` coordinates proxy rotation (`ProxyManager.ts`), browser
  fingerprints, sessions, human-like delays and the per-source circuit breaker for the two
  browser backends (`config/puppeteer.config.ts`, `config/playwright.config.ts`).
- `utils/scraper.ts`'s `getHtmlCached()` fetches HTML with axios first, then falls back to
  a browser.
- `utils/` also holds shared parsing helpers (`parse.ts`, `url.ts`,
  `detectionPatterns.ts`, `madara.ts`, `jsonHtmlBrowse.ts`).
- `config/source.config.ts` holds generic timeouts and circuit-breaker settings, plus two
  config-only placeholder entries. Proxy and user-agent settings are read from the
  `EXT_*` variables in `apps/server/.env.example`.

This stack runs in the server process, not inside the sandbox. Today its only consumer in
the app is the health route's stats.

## Errors

`sourceError.ts` defines `SourceError` and `classifyRequestError()`, which turn a raw
network error into one of the `SourceErrorCode` values in `@projekt-manga/types`. The
server maps each code to an HTTP status and a message the UI can show.

## Testing

```bash
npm run test --workspace=@projekt-manga/extensions            # vitest (builds first)
npm run test:coverage --workspace=@projekt-manga/extensions   # with a coverage report
npm run typecheck --workspace=@projekt-manga/extensions
npm run build --workspace=@projekt-manga/extensions
```

`tests/sandbox.test.ts` runs real sandboxed children, including a deliberately hostile bundle in
`tests/fixtures/sandbox/` that tries to escape. Tests use fixtures and
`tests/helpers/fixture-server.ts`, never live sites.

`npm run dev:server` does not rebuild this workspace, so run the build before checking a
change through a running server.
