/**
 * One-off, manually-run script (not a vitest test — vitest only picks up *.test.ts).
 * Captures real, live responses from each source's site/API into
 * sources/<source>/__tests__/fixtures/ so the colocated characterization tests
 * (sources/<source>/__tests__/index.test.ts) can replay them offline via a local
 * fixture server, without needing the network (or this repo's anti-detection stack) on
 * every test run.
 *
 * Run once from apps/extensions with: npx tsx tests/capture-fixtures.script.ts
 * Re-run only when you deliberately want to refresh what "current behavior" means.
 */
import axios from 'axios';
import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';

const SOURCES_DIR = path.resolve(import.meta.dirname, '..', 'sources');

const UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36';

function client(baseURL: string) {
  return axios.create({
    baseURL,
    timeout: 20000,
    headers: { 'User-Agent': UA, Accept: '*/*' },
    validateStatus: () => true,
  });
}

function fixturesDirFor(source: string): string {
  return path.join(SOURCES_DIR, source, '__tests__', 'fixtures');
}

function saveJson(source: string, name: string, data: unknown) {
  const dir = fixturesDirFor(source);
  mkdirSync(dir, { recursive: true });
  writeFileSync(path.join(dir, `${name}.json`), JSON.stringify(data, null, 2), 'utf-8');
  console.log(`  saved ${source}/${name}.json`);
}

function saveHtml(source: string, name: string, html: string) {
  const dir = fixturesDirFor(source);
  mkdirSync(dir, { recursive: true });
  writeFileSync(path.join(dir, `${name}.html`), html, 'utf-8');
  console.log(`  saved ${source}/${name}.html (${html.length} bytes)`);
}

async function captureMangadex() {
  console.log('mangadex...');
  const api = client('https://api.mangadex.org');

  const searchParams = new URLSearchParams();
  searchParams.append('limit', '5');
  searchParams.append('offset', '0');
  searchParams.append('includes[]', 'cover_art');
  searchParams.append('order[latestUploadedChapter]', 'desc');
  for (const rating of ['safe', 'suggestive', 'erotica']) {
    searchParams.append('contentRating[]', rating);
  }

  const list = await api.get(`/manga?${searchParams.toString()}`);
  if (list.status !== 200) {
    console.warn(`  browse failed: HTTP ${list.status}`);
    return;
  }
  saveJson('mangadex', 'browse', list.data);

  const mangaId = list.data?.data?.[0]?.id;
  if (!mangaId) {
    console.warn('  no manga id in browse response, skipping details/chapters');
    return;
  }

  const detailsParams = new URLSearchParams();
  for (const inc of ['cover_art', 'author', 'artist']) {
    detailsParams.append('includes[]', inc);
  }
  const details = await api.get(`/manga/${mangaId}?${detailsParams.toString()}`);
  saveJson('mangadex', 'manga-details', details.data);

  const chapterParams = new URLSearchParams();
  chapterParams.append('manga', mangaId);
  chapterParams.append('translatedLanguage[]', 'en');
  chapterParams.append('order[volume]', 'asc');
  chapterParams.append('order[chapter]', 'asc');
  chapterParams.append('offset', '0');
  chapterParams.append('limit', '100');
  chapterParams.append('includes[]', 'scanlation_group');
  chapterParams.append('includes[]', 'user');
  chapterParams.append('includeExternalUrl', '0');
  const chapters = await api.get(`/chapter?${chapterParams.toString()}`);
  saveJson('mangadex', 'chapters', chapters.data);

  const chapterId = chapters.data?.data?.[0]?.id;
  if (chapterId) {
    const pages = await api.get(`/at-home/server/${chapterId}`);
    saveJson('mangadex', 'chapter-pages', pages.data);
  }

  const tags = await api.get('/manga/tag');
  saveJson('mangadex', 'tags', tags.data);
}

async function captureNhentai() {
  console.log('nhentai...');
  const api = client('https://nhentai.net');

  const search = await api.get('/api/v2/search', {
    params: { query: 'english', sort: 'date', page: 1 },
  });
  if (search.status !== 200) {
    console.warn(`  search failed: HTTP ${search.status}`);
    return;
  }
  saveJson('nhentai', 'search', search.data);

  const galleryId = search.data?.result?.[0]?.id;
  if (!galleryId) {
    console.warn('  no gallery id in search response, skipping gallery');
    return;
  }

  const gallery = await api.get(`/api/v2/galleries/${galleryId}/`);
  saveJson('nhentai', 'gallery', gallery.data);
}

async function captureMangageko() {
  console.log('mangageko...');
  const api = client('https://mgeko.cc');

  const browse = await api.get('/browse-comics/data/', {
    params: { sort: 'latest', safe_mode: 1, page: 1 },
  });
  if (browse.status !== 200) {
    console.warn(`  browse failed: HTTP ${browse.status}`);
    return;
  }
  saveJson('mangageko', 'browse', browse.data);

  const html: string = browse.data?.results_html || '';
  const slugMatch = html.match(/\/manga\/([^/"]+)/);
  const slug = slugMatch?.[1];
  if (!slug) {
    console.warn('  could not extract a manga slug from browse HTML, skipping details/chapters');
    return;
  }

  const details = await api.get(`/manga/${slug}/`);
  saveHtml('mangageko', 'manga-details', details.data);

  const chapters = await api.get(`/manga/${slug}/all-chapters/`);
  saveHtml('mangageko', 'chapters', chapters.data);

  const chapterHref = String(chapters.data || '').match(/\/reader\/en\/([^/"]+)/);
  const chapterSlug = chapterHref?.[1];
  if (chapterSlug) {
    const reader = await api.get(`/reader/en/${chapterSlug}/`);
    saveHtml('mangageko', 'reader', reader.data);
  } else {
    console.warn('  could not extract a chapter slug from chapters HTML, skipping reader page');
  }
}

async function captureMangatx() {
  console.log('mangatx...');
  const api = client('https://mangatx.cc');

  const list = await api.get('/manga-list');
  if (list.status !== 200) {
    console.warn(`  manga-list failed: HTTP ${list.status}`);
    return;
  }
  saveHtml('mangatx', 'manga-list', list.data);

  const cardMatch = String(list.data || '').match(
    /class="bs"[\s\S]{0,400}?href="[^"]*\/manga\/([^/"]+)"/,
  );
  const mangaId = cardMatch?.[1];
  if (!mangaId) {
    console.warn('  could not extract a manga id from manga-list HTML, skipping details/reader');
    return;
  }

  const details = await api.get(`/manga/${mangaId}/`);
  saveHtml('mangatx', 'manga-details', details.data);

  const chapterMatch = String(details.data || '').match(
    /class="eph-num">\s*<a href="[^"]*\/manga\/([^"]+\/chapter-[^"/]+)"/,
  );
  const chapterPath = chapterMatch?.[1];
  if (chapterPath) {
    const reader = await api.get(`/manga/${chapterPath}/`);
    saveHtml('mangatx', 'reader', reader.data);
  } else {
    console.warn(
      '  could not extract a chapter path from manga-details HTML, skipping reader page',
    );
  }
}

async function captureKissmanga() {
  console.log('kissmanga...');
  const api = client('https://kissmanga.in');

  const list = await api.get('/mangalist/page/1/', { params: { m_orderby: 'latest' } });
  console.log(`  plain axios list HTTP ${list.status}, ${String(list.data).length} bytes`);
  // Save whatever plain axios gets back regardless of outcome — kissmanga is
  // 'cloudflare-first', so a 403/challenge page here is itself a useful fixture for the
  // "blocked" characterization test in tests/sources/kissmanga.test.ts.
  saveHtml(
    'kissmanga',
    'manga-list',
    typeof list.data === 'string' ? list.data : JSON.stringify(list.data),
  );

  if (list.status === 200 && typeof list.data === 'string') {
    const slugMatch = list.data.match(/\/kissmanga\/([^/"]+)/);
    if (slugMatch?.[1]) {
      const details = await api.get(`/kissmanga/${slugMatch[1]}/`);
      saveHtml(
        'kissmanga',
        'manga-details',
        typeof details.data === 'string' ? details.data : JSON.stringify(details.data),
      );
      return;
    }
  }

  console.warn(
    '  plain axios was blocked — trying the real anti-detection pipeline once (this can take a while)...',
  );
  try {
    const { getHtmlCached } = await import('../utils/scraper.js');
    const antiDetectionApi = client('https://kissmanga.in');
    const html = await getHtmlCached(
      'kissmanga',
      antiDetectionApi,
      'https://kissmanga.in',
      '/mangalist/page/1/?m_orderby=latest',
      '.page-content-listing',
      2 * 60 * 1000,
      true,
    );
    saveHtml('kissmanga', 'manga-list', html);
    console.log('  anti-detection pipeline succeeded');
  } catch (error) {
    console.warn(
      `  anti-detection pipeline also failed (${(error as Error).message}) — kissmanga stays uncaptured live; see the synthetic fixture used by tests/sources/kissmanga.test.ts instead.`,
    );
  }
}

async function main() {
  const captures: Array<[string, () => Promise<void>]> = [
    ['mangadex', captureMangadex],
    ['nhentai', captureNhentai],
    ['mangageko', captureMangageko],
    ['mangatx', captureMangatx],
    ['kissmanga', captureKissmanga],
  ];

  for (const [name, fn] of captures) {
    try {
      await fn();
    } catch (error) {
      console.error(`  ${name} capture threw:`, (error as Error).message);
    }
  }
}

main();
