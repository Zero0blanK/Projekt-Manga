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
const output = await mkdtemp(path.join(root, 'build/source-pagination-'));
const mocks = path.join(output, 'fixtures.tsx');
await writeFile(
  mocks,
  `
import React from 'react';
window.paginationEvidence = { requests: [], failures: [] };
const capabilities = { search: true, languageFilter: false };
export const useSourceCapabilities = () => ({ capabilities });
export const useSourceFilters = () => ({ filters: [] });
export const useSourceDisplayLanguage = () => ['all'];
export const sourceLanguageValues = () => ({});
export const useScrollBehavior = () => 'auto';
export const reportError = error => window.paginationEvidence.failures.push(error.message);
export const SourceResultCard = ({item}) => <article className="h-32 rounded-xl bg-muted p-3">{item.title}</article>;
let attempts = 0;
const item = id => ({id, source:'fixture', title:'Title '+id});
export const searchSourceMangaPage = async (_source, params) => {
  window.paginationEvidence.requests.push(params);
  if (!params.cursor) return {items:[item('1'),item('1'),item('2'),item('3')],hasMore:true,nextCursor:'opaque-2'};
  if (params.cursor === 'opaque-2') return {items:[item('3'),item('4'),item('5')],hasMore:true,nextCursor:'opaque-3'};
  if (++attempts === 1) return {items:[item('5'),item('6')],hasMore:true,nextCursor:'opaque-3'};
  return {items:[item('5'),item('6')],hasMore:false};
};
`,
);
await writeFile(
  path.join(output, 'main.tsx'),
  `
import React from 'react';
import {createRoot} from 'react-dom/client';
import {SourceSearchCarousel} from '@/components/discover/source-search-carousel';
import '@/styles.css';
createRoot(document.getElementById('root')).render(<SourceSearchCarousel source={{id:'fixture',name:'Fixture',lang:'en',accent:'#5577aa'}} query="fixture" />);
`,
);
await writeFile(
  path.join(output, 'index.html'),
  '<html><head><meta name="viewport" content="width=device-width, initial-scale=1"></head><body><div id="root"></div><script type="module" src="/main.tsx"></script></body></html>',
);
const aliases = [
  '@projekt-manga/api-client',
  '@/lib/library-store',
  '@/lib/source-display-language',
  '@/lib/scroll',
  '@/lib/report-error',
  '@/components/discover/popular-section',
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
        ...aliases.map((find) => ({ find, replacement: mocks })),
        { find: '@', replacement: path.join(root, 'apps/web/src') },
      ],
    },
    server: { host: '127.0.0.1', port: 0, fs: { allow: [root] } },
  });
  await server.listen();
  browser = await chromium.launch({ headless: true });
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
    await page.route('**/*', (route) =>
      new URL(route.request().url()).hostname === '127.0.0.1' ? route.continue() : route.abort(),
    );
    await page.goto(server.resolvedUrls.local[0]);
    await page.getByText('Title 1', { exact: true }).waitFor();
    assert.equal(await page.getByText('Title 1', { exact: true }).count(), 1);
    const advance = () =>
      page.locator('.overflow-x-auto').evaluate((el) => {
        el.scrollLeft = el.scrollWidth;
        el.dispatchEvent(new Event('scroll'));
      });
    await advance();
    await page.getByText('Title 4', { exact: true }).waitFor();
    assert.equal(await page.getByText('Title 3', { exact: true }).count(), 1);
    await advance();
    await page.getByRole('button', { name: 'Could not load more results · Retry' }).waitFor();
    assert.equal(await page.getByText('Title 6', { exact: true }).count(), 0);
    await advance();
    assert.equal(await page.evaluate(() => window.paginationEvidence.requests.length), 3);
    await page.getByRole('button', { name: 'Could not load more results · Retry' }).click();
    await page.getByText('Title 6', { exact: true }).waitFor();
    await advance();
    const evidence = await page.evaluate(() => window.paginationEvidence);
    assert.deepEqual(
      evidence.requests.map((request) => request.cursor),
      [undefined, 'opaque-2', 'opaque-3', 'opaque-3'],
    );
    assert.equal(evidence.failures.length, 1);
    assert.equal(await page.getByText('Title 5', { exact: true }).count(), 1);
    await page.screenshot({
      path: path.join(output, `${mobile ? 'touch' : 'desktop'}-results.png`),
      fullPage: true,
    });
    await context.tracing.stop({
      path: path.join(output, `${mobile ? 'touch' : 'desktop'}-trace.zip`),
    });
    passed.push(
      `${mobile ? 'touch 375px' : 'desktop 1280px'}: short native page continuation, overlap dedup, repeated cursor retry, terminal page`,
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
