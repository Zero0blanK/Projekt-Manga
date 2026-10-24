import assert from 'node:assert/strict';
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath, pathToFileURL } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const fromWeb = createRequire(path.join(root, 'apps/web/package.json'));
const fromExtensions = createRequire(path.join(root, 'apps/extensions/package.json'));
const { createServer } = await import(pathToFileURL(fromWeb.resolve('vite')).href);
const { default: react } = await import(
  pathToFileURL(fromWeb.resolve('@vitejs/plugin-react')).href
);
const { default: tailwind } = await import(
  pathToFileURL(fromWeb.resolve('@tailwindcss/postcss')).href
);
const { chromium } = fromExtensions('playwright');
await mkdir(path.join(root, 'build'), { recursive: true });
const output = await mkdtemp(path.join(root, 'build/migration-interactions-'));
const mocks = path.join(output, 'fixtures.tsx');
await writeFile(
  mocks,
  `
import React from 'react';
window.migrationEvidence = { searches: [], writes: [] };
const sources = ['alpha', 'beta', 'gamma'].map(id => ({ id, name: id[0].toUpperCase() + id.slice(1), lang: 'en' }));
export const useSources = () => ({ sources: [{id:'old',name:'Original',lang:'en'}, ...sources] });
export const useInstalledExtensions = () => ({ installed: [] });
export const useContentPrivacy = () => [{ hideAdult: false }];
export const isAdultSource = () => false;
export const useMangaLibrary = () => ({ manga: [], refresh: async () => {} });
export const useLibraryState = () => ({ shelf: { fixture: 'reading' }, bookmarks: ['fixture'] });
export const useCurrentUser = () => ({ user: null, loading: false });
export const queryKeys = { session: ['session'] };
export const queryClient = { getQueryData: () => null };
let appState = { categoryMembers: {}, settings: JSON.parse(localStorage.getItem('fixture-settings') || '{}') };
const listeners = new Set();
export const getAppState = () => appState;
export const useAppState = selector => React.useSyncExternalStore(callback => { listeners.add(callback); return () => listeners.delete(callback); }, () => selector(appState), () => selector(appState));
export const actions = { toggleCategoryMember: () => {}, setSetting: (key, value) => { appState = {...appState, settings: {...appState.settings, [key]: value}}; localStorage.setItem('fixture-settings', JSON.stringify(appState.settings)); listeners.forEach(callback => callback()); return true; } };
export const useRouter = () => ({ push: href => { history.pushState({}, '', href); window.dispatchEvent(new PopStateEvent('popstate')); } });
export const refreshDownloads = () => {};
const record = async (...args) => { window.migrationEvidence.writes.push(args); };
export const libraryActions = { setShelf: record, setBookmark: record };
export const addSourceMangaToLibrary = async () => { await record('add'); return 'target'; };
export const setMangaInLibrary = record;
export const markChapterAsRead = record;
export const getAllDownloads = async () => [{id:'old-download',manga_id:'fixture'}, {id:'other-download',manga_id:'other'}];
export const cancelDownload = id => record('cancel', id);
export const buildImageProxyUrl = url => url;
export const searchSourceMangaPage = async source => {
  window.migrationEvidence.searches.push(source);
  return {hasMore: false, items: Array.from({length: source === 'alpha' ? 20 : source === 'beta' ? 2 : 0}, (_, index) => ({ id: source + index, source, title: source[0].toUpperCase() + source.slice(1) + ' Match ' + (index + 1), thumbnail_url: '' }))};
};
const chapter = { id: 'chapter1', chapter_number: 1, name: 'Chapter 1', scanlator: 'Fixture' };
export const getMangaDetailsById = async () => ({ chapters: [{...chapter, id:'original1', is_read:true}] });
export const getSourceMangaDetails = async (source,id) => ({ id,slug:id,title:'Replacement',thumbnail_url:'',chapters:[chapter],genres:[] });
export const Cover = ({className}) => <span className={className + ' block rounded-xl bg-muted'} />;
export default function Link({children,href,...props}) { return <a href={href} {...props}>{children}</a>; }
`,
);
await writeFile(
  path.join(output, 'main.tsx'),
  `
import React from 'react';
import { createRoot } from 'react-dom/client';
import { SourceMigration } from '@/components/manga-detail/source-switch';
import '@/styles.css';
function App() {
  const pathname = React.useSyncExternalStore(callback => { window.addEventListener('popstate', callback); return () => window.removeEventListener('popstate', callback); }, () => location.pathname);
  if (pathname.startsWith('/discover/preview')) return <main><h1>Fixture preview</h1><button onClick={() => history.back()}>Back to migration</button></main>;
  return <main className="mx-auto max-w-5xl px-6 py-8 sm:px-8"><SourceMigration manga={{id:'fixture',title:'Original Fixture',source:'old',thumbnailUrl:null,chapters:1}} /></main>;
}
createRoot(document.getElementById('root')).render(<App />);
`,
);
await writeFile(
  path.join(output, 'index.html'),
  '<html><head><meta name="viewport" content="width=device-width, initial-scale=1"></head><body><div id="root"></div><script type="module" src="/main.tsx"></script></body></html>',
);
const mockImports = [
  'next/link',
  'next/navigation',
  '@projekt-manga/api-client',
  '@/lib/library-store',
  '@/lib/extensions-store',
  '@/lib/discover-actions',
  '@/lib/session-resource',
  '@/lib/query-client',
  '@/lib/app-store',
  './app-store',
  './session-resource',
  './query-client',
  '@/components/discover/content-privacy',
  '@/components/cover',
  '@/components/downloads/row-data',
];
let server;
let browser;
const errors = [];
const passed = [];
try {
  server = await createServer({
    configFile: false,
    envDir: output,
    root: output,
    plugins: [react()],
    css: { postcss: { plugins: [tailwind()] } },
    resolve: {
      alias: [
        ...mockImports.map((find) => ({ find, replacement: mocks })),
        { find: '@', replacement: path.join(root, 'apps/web/src') },
      ],
    },
    server: { host: '127.0.0.1', port: 0, fs: { allow: [root] } },
  });
  await server.listen();
  browser = await chromium.launch({ headless: true });
  const url = server.resolvedUrls.local[0];
  for (const mobile of [false, true]) {
    const context = await browser.newContext({
      viewport: mobile ? { width: 375, height: 812 } : { width: 1280, height: 900 },
      hasTouch: mobile,
      isMobile: mobile,
    });
    await context.tracing.start({ screenshots: true, snapshots: true });
    const page = await context.newPage();
    page.on('pageerror', (error) => errors.push(error.message));
    page.on('console', (message) => {
      if (message.type() === 'error') errors.push(message.text());
    });
    await page.route('**/*', (route) => {
      if (new URL(route.request().url()).hostname !== '127.0.0.1') return route.abort();
      return route.continue();
    });
    await page.goto(url);
    const click = (locator) => (mobile ? locator.tap() : locator.click());
    await page.getByRole('heading', { name: 'Data to migrate' }).waitFor();
    for (const source of ['Alpha', 'Beta', 'Gamma'])
      await click(page.getByRole('button', { name: `Select ${source}`, exact: true }));
    const toggle = page.getByRole('switch', { name: 'Bookmark', exact: true });
    await click(toggle.getByText('Bookmark', { exact: true }));
    assert.equal(await toggle.getAttribute('aria-checked'), 'false');
    await click(toggle.locator('span[aria-hidden=true]'));
    assert.equal(await toggle.getAttribute('aria-checked'), 'true');
    await click(page.getByRole('switch', { name: 'Hide entries without a match' }));
    assert.deepEqual(await page.evaluate(() => window.migrationEvidence.searches), []);
    const selected = page.getByRole('region', { name: /^Selected/ });
    const order = async () => selected.getByRole('button').allTextContents();
    const row = (name) =>
      page.getByRole('button', { name: `Remove ${name} from selected sources` });
    const dragRow = async (name, target, blankArea = false) => {
      const dragged = row(name);
      await dragged.scrollIntoViewIfNeeded();
      const from = await dragged.boundingBox();
      const to = await row(target).boundingBox();
      const x = from.x + (blankArea ? from.width * 0.7 : 75);
      const y = from.y + from.height / 2;
      const targetY = to.y + to.height / 2;
      if (mobile) {
        const cdp = await context.newCDPSession(page);
        await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x, y }] });
        for (let step = 1; step <= 12; step++)
          await cdp.send('Input.dispatchTouchEvent', {
            type: 'touchMove',
            touchPoints: [{ x, y: y + ((targetY - y) * step) / 12 }],
          });
        await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
        await cdp.detach();
      } else {
        await page.mouse.move(x, y);
        await page.mouse.down();
        await page.mouse.move(x, targetY, { steps: 12 });
        await page.mouse.up();
      }
    };
    await dragRow('Alpha', 'Gamma');
    assert.deepEqual(await order(), ['1Betaen', '2Gammaen', '3Alphaen']);
    await dragRow('Alpha', 'Beta', true);
    assert.deepEqual(await order(), ['1Alphaen', '2Betaen', '3Gammaen']);
    await click(row('Alpha'));
    assert.equal(await selected.getByRole('button').count(), 2);
    await click(page.getByRole('button', { name: 'Select Alpha', exact: true }));
    assert.equal(await selected.getByRole('button').count(), 3);
    await row('Alpha').focus();
    await page.keyboard.press('ArrowUp');
    assert.deepEqual(await order(), ['1Betaen', '2Alphaen', '3Gammaen']);
    assert.equal(await page.getByRole('button', { name: /Move .* (up|down)/ }).count(), 0);
    assert.equal(
      await page.evaluate(() => document.documentElement.scrollWidth > innerWidth),
      false,
    );
    await page.screenshot({
      path: path.join(output, `${mobile ? 'touch' : 'desktop'}-sources.png`),
      fullPage: true,
    });
    await page.getByRole('button', { name: 'Apply', exact: true }).click();
    await page.getByRole('heading', { name: 'Search manga' }).waitFor();
    await page
      .getByRole('button', { name: 'Select Alpha Match 1 from Alpha', exact: true })
      .waitFor();
    assert.deepEqual(await page.evaluate(() => window.migrationEvidence.searches), [
      'beta',
      'alpha',
      'gamma',
    ]);
    assert.equal(await page.getByRole('heading', { name: /Gamma/ }).count(), 0);
    const rail = page.getByRole('list', { name: 'Manga results from Alpha' });
    assert.equal(await rail.evaluate((element) => element.scrollWidth > element.clientWidth), true);
    await page.getByRole('button', { name: 'Next results from Alpha' }).click();
    await page.waitForFunction(
      () => document.querySelector('ul[aria-label="Manga results from Alpha"]').scrollLeft > 0,
    );
    await page.screenshot({
      path: path.join(output, `${mobile ? 'touch' : 'desktop'}-search.png`),
      fullPage: true,
    });
    const inspectCard = page.getByRole('button', {
      name: 'Select Alpha Match 5 from Alpha',
      exact: true,
    });
    await inspectCard.scrollIntoViewIfNeeded();
    const position = {
      left: await rail.evaluate((element) => element.scrollLeft),
      y: await page.evaluate(() => scrollY),
    };
    const inspectBox = await inspectCard.boundingBox();
    const inspectPoint = { x: inspectBox.x + inspectBox.width / 2, y: inspectBox.y + 45 };
    if (mobile) {
      const cdp = await context.newCDPSession(page);
      await cdp.send('Input.dispatchTouchEvent', {
        type: 'touchStart',
        touchPoints: [inspectPoint],
      });
      await page.getByRole('heading', { name: 'Fixture preview' }).waitFor();
      await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
      await cdp.detach();
    } else {
      await page.mouse.move(inspectPoint.x, inspectPoint.y);
      await page.mouse.down();
      await page.getByRole('heading', { name: 'Fixture preview' }).waitFor();
      await page.mouse.up();
    }
    await page.reload();
    await page.getByRole('heading', { name: 'Fixture preview' }).waitFor();
    const searchesAfterReload = await page.evaluate(() => window.migrationEvidence.searches.length);
    await click(page.getByRole('button', { name: 'Back to migration' }));
    await page.getByRole('heading', { name: 'Search manga' }).waitFor();
    await page.waitForFunction((position) => {
      const element = document.querySelector('ul[aria-label="Manga results from Alpha"]');
      return (
        element &&
        Math.abs(element.scrollLeft - position.left) <= 2 &&
        Math.abs(scrollY - position.y) <= 2
      );
    }, position);
    assert.equal(
      await page.evaluate(() => window.migrationEvidence.searches.length),
      searchesAfterReload,
    );
    assert.equal(
      await page.getByRole('searchbox', { name: 'Search manga for migration' }).inputValue(),
      'Original Fixture',
    );
    await page
      .getByRole('button', { name: 'Select Alpha Match 1 from Alpha', exact: true })
      .click();
    await page.getByRole('heading', { name: 'Migrate manga' }).waitFor();
    await page.getByRole('button', { name: 'Migrate', exact: true }).waitFor();
    await page.screenshot({
      path: path.join(output, `${mobile ? 'touch' : 'desktop'}-review.png`),
      fullPage: true,
    });
    await page.getByRole('button', { name: 'Migration options' }).click();
    await page.getByRole('menuitem', { name: 'Change match' }).waitFor();
    await page.keyboard.press('Escape');
    await page.getByRole('button', { name: 'Migrate', exact: true }).click();
    await page.getByRole('heading', { name: 'Migration complete' }).waitFor();
    const writes = await page.evaluate(() => window.migrationEvidence.writes);
    assert.deepEqual(
      writes.filter((write) => write[0] === 'cancel'),
      [['cancel', 'old-download']],
    );
    assert.deepEqual(writes.at(-1), ['fixture', false]);
    await page.screenshot({
      path: path.join(output, `${mobile ? 'touch' : 'desktop'}-complete.png`),
      fullPage: true,
    });
    assert.equal(
      await page.getByRole('link', { name: 'Open migrated title' }).getAttribute('href'),
      '/manga/target',
    );
    await context.tracing.stop({
      path: path.join(output, `${mobile ? 'touch' : 'desktop'}-trace.zip`),
    });
    passed.push(
      `${mobile ? 'touch 375px' : 'mouse 1280px'}: row drag, click removal, keyboard order, option body/switch clicks, Apply-only navigation, ordered search, empty-source hiding, horizontal rails, hold preview/back restoration, kebab, fixture transfer/cleanup`,
    );
    await context.close();
  }
  assert.deepEqual(errors, []);
  await writeFile(
    path.join(output, 'report.json'),
    JSON.stringify({ passed, errors, isolated: true }, null, 2),
  );
  console.log(JSON.stringify({ passed, errors, output }, null, 2));
} finally {
  await browser?.close();
  await server?.close();
}
