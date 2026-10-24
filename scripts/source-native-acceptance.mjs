import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const appRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const sourceRoot = path.resolve(
  process.env.PROJEKT_MANGA_SOURCES_DIR ?? path.join(appRoot, '..', 'projektmanga-sources'),
);
const { resolveSource } = await import(
  pathToFileURL(path.join(sourceRoot, 'scripts/source-layout.mjs')).href
);
const { spawnSandboxedSource } = await import(
  pathToFileURL(path.join(appRoot, 'apps/extensions/dist/sandbox/index.js')).href
);
const { sourceCataloguePageSchema, sourceCapabilitiesSchema } = await import(
  pathToFileURL(path.join(appRoot, 'packages/schemas/dist/index.js')).href
);
const fixtures = JSON.parse(
  await readFile(path.join(sourceRoot, 'tests/fixtures/source-search-fixtures.json'), 'utf8'),
);
const originalFetch = globalThis.fetch;
const ids = (start, count) => Array.from({ length: count }, (_, index) => start + index);

function catalogueFixture(key, url) {
  if (key.startsWith('mangadex')) {
    assert.equal(url.pathname, '/manga');
    const offset = Number(url.searchParams.get('offset') ?? 0);
    const limit = Number(url.searchParams.get('limit') ?? 100);
    assert.ok(limit > 0 && limit <= 100);
    const data = ids(offset, Math.max(0, Math.min(limit, 103 - offset))).map((id) => ({
      ...fixtures.mangadex.search.data[0],
      id: `fixture-${id}`,
    }));
    return Response.json({ data, limit, offset, total: 103 });
  }
  const isNext =
    /\/(?:page|pag)\/2\//.test(url.pathname) ||
    Number(url.searchParams.get('page')) === 2 ||
    Number(url.searchParams.get('offset')) > 0;
  const numbers = isNext ? [3] : [1, 2];
  const next = new URL(url);
  if (key === 'hentaifox') next.pathname = '/page/2/';
  else if (key === 'weebcentral') next.searchParams.set('offset', '32');
  else next.searchParams.set('page', '2');
  const cards = numbers
    .map((id) => {
      if (key === 'hentaifox')
        return `<div class="thumb"><h2 class="g_title"><a href="/gallery/${1000 + id}/">Fixture ${id}</a></h2><img src="/cover.jpg"></div>`;
      if (key === 'weebcentral') {
        const nativeId = String(id).padStart(26, '0');
        return `<a href="/series/${nativeId}/fixture"><img alt="Fixture ${id} Cover" src="/cover.jpg"></a><a href="/series/${nativeId}/fixture">Fixture ${id}</a>`;
      }
      if (key === 'leercapitulo')
        return `<article class="lc-card"><a class="lc-card-name" href="/manga/fixture/title-${id}/">Fixture ${id}</a><img src="/cover.jpg"></article>`;
      return `<a href="/comics/title-${id}"><img src="/cover.jpg" alt="Fixture ${id}"></a>`;
    })
    .join('');
  const href = `${next.pathname}${next.search}`.replaceAll('&', '&amp;');
  const continuation = isNext
    ? ''
    : key === 'weebcentral'
      ? `<button hx-get="${href}">View More Results...</button>`
      : `<nav class="pagination"><a rel="next" href="${href}">Next</a></nav>`;
  return new Response(cards + continuation, { headers: { 'content-type': 'text/html' } });
}

try {
  for (const key of [
    'hentaifox',
    'weebcentral',
    'leercapitulo',
    'asurascans',
    'mangadex',
    'mangadex-fr',
    'mangadex-ja',
  ]) {
    const { manifest } = await resolveSource(key, sourceRoot);
    const calls = [];
    globalThis.fetch = async (input) => {
      const url = new URL(String(input));
      assert.ok(
        manifest.allowed_hosts.includes(url.hostname),
        `Unexpected fixture host: ${url.hostname}`,
      );
      calls.push(url);
      return catalogueFixture(key, url);
    };
    const source = spawnSandboxedSource(
      {
        id: key,
        name: manifest.name,
        lang: manifest.lang,
        base_url: manifest.base_url,
        isNSFW: manifest.content_rating === 'nsfw',
      },
      {
        bundlePath: path.join(sourceRoot, 'dist', `${key}.js`),
        allowedNetHosts: manifest.allowed_hosts,
        timeoutMs: 15000,
      },
    );
    try {
      const capabilities = sourceCapabilitiesSchema.parse(await source.getCapabilities());
      assert.equal(capabilities.nativePagination, true, `${key} native methods missing`);
      const limit = key.startsWith('mangadex') ? 100 : 2;
      const first = sourceCataloguePageSchema.parse(
        await source.fetchMangaPage('popular', { limit }),
      );
      assert.ok(
        first.items.length && first.hasMore && first.nextCursor,
        `${key} initial continuation`,
      );
      const second = sourceCataloguePageSchema.parse(
        await source.fetchMangaPage('popular', { limit, cursor: first.nextCursor }),
      );
      assert.ok(second.items.length, `${key} second-page items`);
      assert.equal(second.hasMore, false, `${key} explicit end`);
      assert.ok(
        second.items.every((item) => !first.items.some((previous) => previous.id === item.id)),
        `${key} native identities overlap`,
      );
      const requestsBeforeInvalid = calls.length;
      await assert.rejects(source.fetchMangaPage('popular', { limit, cursor: 'invalid-cursor' }));
      assert.equal(
        calls.length,
        requestsBeforeInvalid,
        `${key} invalid cursor reached fetch broker`,
      );
      console.log(
        `${key}: native first/next/end, identities and invalid cursor passed through restricted IPC (${calls.length} fixture requests)`,
      );
    } finally {
      source.dispose();
    }
  }
} finally {
  globalThis.fetch = originalFetch;
}
