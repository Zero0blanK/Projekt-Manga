<div align="center">

![ProjektManga logo](./apps/web/public/brand/ProjektManga.origin.svg 'ProjektManga')

# Projekt Manga

Read manga, webtoons and comics from the sources you choose, on your desktop or in your browser.
Your library stays on your machine.

![Next.js](https://img.shields.io/badge/Frontend-Next.js%2016-black?style=flat-square&logo=next.js&logoColor=white) ![React](https://img.shields.io/badge/React-19-149eca?style=flat-square&logo=react&logoColor=white) ![Electron](https://img.shields.io/badge/Desktop-Electron-47848F?style=flat-square&logo=electron&logoColor=white) ![Express](https://img.shields.io/badge/Backend-Express-000000?style=flat-square&logo=express&logoColor=white) ![Prisma](https://img.shields.io/badge/ORM-Prisma-0284c7?style=flat-square&logo=prisma&logoColor=white) ![TypeScript](https://img.shields.io/badge/TypeScript-Strict-3178C6?style=flat-square&logo=typescript&logoColor=white)

[Documentation](docs/README.md) · [Report a bug](https://github.com/Zero0blanK/Projekt-Manga/issues) · [Request a feature](https://github.com/Zero0blanK/Projekt-Manga/issues)

[![License: MIT](https://img.shields.io/badge/license-MIT-0877d2?labelColor=27303D)](LICENSE)

</div>

## Download

Get the Windows installer from the [latest release](https://github.com/Zero0blanK/Projekt-Manga/releases/latest).
The app updates itself when a new release is published.

The installer isn't code-signed yet, so Windows may show "Windows protected your PC" on first
run. Choose **More info → Run anyway**.

## Features

- **Bring your own sources.** No source ships with the app. Add a repository (Discover →
  Extensions → **Add ProjektManga sources** is one click) and install the sources you want. Each
  one runs in its own sandboxed process, can only reach the sites it declares, and can be updated
  without a new app release.
- **Library** with shelves, categories, unread and downloaded filters, and "new since your last
  visit" markers on each title.
- **Reader** for paged and long-strip formats: reading direction, fit and zoom, two-page spreads,
  tap zones, keyboard shortcuts and an optional auto-advance to the next chapter.
- **Offline reading.** Download chapters and read them without a connection; local CBZ files open
  in the desktop app.
- **Library updates** in the background, with a log of what changed and why a source failed.
- **Move a title to another source** without losing progress, shelf, rating or history.
- **No account needed.** Signing in is optional and adds sync between devices.
- **Tracker sync** with AniList (progress, status and score, both ways).
- **Desktop app or web app** from the same code. The desktop app bundles everything it needs,
  including its own local database.

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

CI runs these (plus integration tests, builds and a Windows job) on every push to `development`.

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md) for local setup, conventions and how to write a source.

## Disclaimer

This application does not host or distribute any content. Content accessed or downloaded through
the app comes from third-party sources the user installs, is stored on the user's own device, and
is not managed or controlled by the developers.

## License

Copyright © 2025–present Projekt Manga. Licensed under the [MIT License](LICENSE).
