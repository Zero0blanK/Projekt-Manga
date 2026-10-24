# @projekt-manga/api-client

The only place HTTP calls to `apps/server` are defined. Components never call `fetch`
against the API directly — that rule is what keeps request shapes, error translation and the
response envelope in one place instead of scattered across the UI.

## Layout

`client.ts` owns `request()`; every other module is a thin domain wrapper over it.

```text
src/
  client.ts    request(), buildApiUrl(), ApiError, base-URL resolution
  runtime.ts   the desktop local-data bridge check
  <domain>.ts  manga, chapter, library, history, source, download, auth, sync, tracker, …
```

## Two things here are easy to get wrong

**There are two base URLs, and they are not interchangeable.**

- `resolveClientBaseUrl()` backs `buildApiUrl()` — URLs handed to the _browser_ (an
  `<img src>`, an `EventSource`). In the installer's single-origin mode this is the relative
  `/api`, and it must stay relative even when produced during SSR, because the browser is
  what resolves it.
- `resolveRequestBaseUrl()` backs `request()` — `fetch` issued by _this_ process. On the
  server it absolutises a relative base, because Node's `fetch` has no origin to resolve
  against and throws.

Using the request base for a browser URL produces absolute loopback `<img src>` values that
`next/image` then rejects. That regression is the reason the two are separate.

**Some functions transparently skip HTTP.** `runtime.ts`'s `hasLocalDataBridge()` lets a
handful of calls (`getManga`, `getMangaDetailsById`, chapter mark-read, history) read and
write the desktop app's local SQLite database instead, so the desktop app works offline. In a
plain browser `window.desktop` is undefined and every call falls through to HTTP, so nothing
in `apps/web` needs to know which transport it is using. Add a local branch only when the
desktop genuinely needs that operation offline — see the comments in `chapter.ts` for the
ones deliberately left HTTP-only.

## Consuming it

`apps/web` and `apps/desktop` import from this package's **built `dist/`**, not its source.
Editing `src/` changes nothing until it is rebuilt; the `pre*` hooks on their `dev`, `build`
and `typecheck` scripts handle that, but a bare `npx tsc` inside a workspace does not. See
the project's architecture guidance.

```bash
npm run build --workspace=@projekt-manga/api-client
```
