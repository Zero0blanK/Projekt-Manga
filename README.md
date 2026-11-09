<div align="center">

![ProjektManga logo](./apps/web/public/brand/ProjektManga.origin.svg 'ProjektManga')

# Projekt Manga

Read manga, webtoons and comics from the sources you choose, on your desktop or in your browser.
Your library stays on your machine.

![Next.js](https://img.shields.io/badge/Frontend-Next.js%2016-black?style=flat-square&logo=next.js&logoColor=white) ![React](https://img.shields.io/badge/React-19-149eca?style=flat-square&logo=react&logoColor=white) ![Electron](https://img.shields.io/badge/Desktop-Electron-47848F?style=flat-square&logo=electron&logoColor=white) ![Express](https://img.shields.io/badge/Backend-Express-000000?style=flat-square&logo=express&logoColor=white) ![Prisma](https://img.shields.io/badge/ORM-Prisma-0284c7?style=flat-square&logo=prisma&logoColor=white) ![TypeScript](https://img.shields.io/badge/TypeScript-Strict-3178C6?style=flat-square&logo=typescript&logoColor=white)

[Download](https://github.com/Zero0blanK/Projekt-Manga/releases/latest) · [Contributing](CONTRIBUTING.md) · [Report a bug](https://github.com/Zero0blanK/Projekt-Manga/issues) · [Request a feature](https://github.com/Zero0blanK/Projekt-Manga/issues)

[![License: MIT](https://img.shields.io/badge/license-MIT-0877d2?labelColor=27303D)](LICENSE)

</div>

## Download

Get the Windows installer from the [latest release](https://github.com/Zero0blanK/Projekt-Manga/releases/latest)
(about 190 MB).

When a new version is out, the app shows what changed and waits for you. Nothing downloads until
you choose **Update now**. The update then installs into the same folder and the app reopens by
itself.

The installer isn't code-signed yet, so Windows may show "Windows protected your PC" on first
run. Choose **More info → Run anyway**.

## Features

- **Bring your own sources.** No source ships with the app. Add a repository by its URL in
  Discover and install the sources you want. Each one runs in its own sandboxed process, can only
  reach the sites it declares, and can be updated without a new app release.
- **Library** with shelves, categories, filters for unread, downloaded, publication status and
  tags, and "new since your last visit" markers on each title.
- **Reader** for paged and long-strip formats: reading direction, fit and zoom, two-page spreads,
  tap zones, keyboard shortcuts and an optional auto-advance to the next chapter.
- **Translate pages.** Japanese text is read on your device, then translated with LibreTranslate
  or DeepL.
- **Offline reading.** Download chapters and read them without a connection. Local CBZ, ZIP and
  EPUB files and comic folders open in the desktop app.
- **Library updates** in the background, with a log of what changed and why a source failed.
  New chapters can also alert you through ntfy, Discord, Telegram or a webhook.
- **Move a title to another source** without losing progress, shelf, rating or history.
- **Backups**, automatic or on demand, and imports from Mihon/Tachiyomi backups and Suwayomi.
- **No account needed.** Signing in is optional and adds sync between devices.
- **Tracker sync** with AniList, MyAnimeList, MangaUpdates, Kitsu, Shikimori, Bangumi, Komga and
  Kavita.
- **Desktop app or web app** from the same code. The desktop app bundles everything it needs,
  including its own local database, and can be locked with a PIN.

## Running it from source

Requires **Node.js 25 or newer** (the source sandbox depends on it).

```bash
git clone https://github.com/Zero0blanK/Projekt-Manga.git
cd Projekt-Manga
npm install
cp apps/server/.env.example apps/server/.env    # the defaults work as-is
npm run db:migrate --workspace=@projekt-manga/server

npm run dev:server   # API on :4000
npm run dev:web      # web app on :3000, in a second terminal
```

`npm run dev:desktop:all` starts the API, the web app and the Electron shell together.

Then open the app, go to **Discover → Extensions** and add a source repository.

## Project layout

An npm-workspaces monorepo:

```text
apps/web              Next.js 16 + React 19 (also the desktop app's UI)
apps/server           Express + Prisma + SQLite API
apps/desktop          Electron shell and installer
apps/extensions       Sandbox that runs installed sources
packages/types        Shared TypeScript types
packages/schemas      Zod validation schemas
packages/api-client   The only place the web app calls the API from
```

## Checks

```bash
npm run lint
npm run typecheck
npm test                       # unit tests, every workspace
npm run smoke -- browser       # end-to-end browser smoke against a fixture API
```

CI runs these on every pull request to `main`, plus integration and migration tests, builds and a
Windows job that builds the installer and checks it.

## Building the installer

```bash
npm run package:desktop
```

This writes `apps/desktop/release/Projekt-Manga-Setup-<version>.exe`, with the unpacked app beside
it in `win-unpacked`. To check that build without a network or your own library, run:

```bash
node apps/desktop/scripts/check-packaged.mjs --measure
```

The check uses throwaway databases and a fake source. It starts the packaged API and web server,
runs a source in the sandbox and reads Japanese text from a test image. It also prints the app's
size and how long the API takes to start.

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md) for local setup, conventions and how to write a source.

## Disclaimer

This application does not host or distribute any content. Content accessed or downloaded through
the app comes from third-party sources the user installs, is stored on the user's own device, and
is not managed or controlled by the developers.

## License

Copyright © 2025–present Projekt Manga. Licensed under the [MIT License](LICENSE).
