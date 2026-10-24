// Ad-hoc, on-demand verification that an installed source extension actually works
// against the real upstream site — not mocked. Hits real network endpoints, so it's a
// separate script rather than part of the regular test suite (which must stay
// fast/offline). Reads whatever this machine's database currently has installed — install
// the sources you want to check first (Discover → Add sources, or the
// /api/extensions/installed endpoint) before running this.
//
// Usage:
//   npx tsx scripts/verify-extensions.ts                 # every installed source
//   npx tsx scripts/verify-extensions.ts mangadex         # just one
import { getInstalledSandboxedSources } from '../src/services/sandboxedSourceRegistry.service.js';
import type { Source, Mangas, MangaDetails, Chapters } from '@projekt-manga/types';

interface StepResult {
  step: string;
  ok: boolean;
  detail: string;
}

async function step<T>(
  results: StepResult[],
  name: string,
  fn: () => Promise<T>,
  describe: (value: T) => string,
): Promise<T | null> {
  try {
    const value = await fn();
    results.push({ step: name, ok: true, detail: describe(value) });
    return value;
  } catch (error) {
    results.push({
      step: name,
      ok: false,
      detail: error instanceof Error ? error.message : String(error),
    });
    return null;
  }
}

async function verifySource(source: Source): Promise<StepResult[]> {
  const results: StepResult[] = [];

  const mangaList = await step(
    results,
    'fetchManga("latest")',
    () => source.fetchManga('latest', { limit: 5, offset: 0 }, {}),
    (list: Mangas[]) =>
      `${list.length} result(s) — first: "${list[0]?.title ?? 'n/a'}" (id=${list[0]?.id ?? 'n/a'})`,
  );

  if (!mangaList || mangaList.length === 0) {
    results.push({
      step: 'fetchMangaDetails / fetchChapters / fetchChapterPages',
      ok: false,
      detail: 'skipped — no manga to inspect',
    });
    return results;
  }

  const target = mangaList[0];

  const details = await step(
    results,
    'fetchMangaDetails(id)',
    () => source.fetchMangaDetails(target.id),
    (d: MangaDetails) =>
      `title="${d.title}", status=${d.status}, chapters=${d.chapters.length}, genres=[${d.genres.slice(0, 3).join(', ')}]`,
  );

  const chapters: Chapters[] | null = details?.chapters?.length
    ? details.chapters
    : await step(
        results,
        'fetchChapters(id)',
        () => source.fetchChapters(target.id),
        (c: Chapters[]) => `${c.length} chapter(s)`,
      );

  if (!chapters || chapters.length === 0) {
    results.push({
      step: 'fetchChapterPages',
      ok: false,
      detail: 'skipped — no chapters to inspect',
    });
    return results;
  }

  const chapter = chapters[0];

  await step(
    results,
    `fetchChapterPages("${chapter.name || chapter.id}")`,
    () => source.fetchChapterPages(chapter.id, target.slug, { limit: 5, offset: 0 }),
    (pages) => {
      const withUrl = pages.items.filter((p) => !!p.image_url).length;
      return `${pages.items.length}/${pages.total} page(s) returned, ${withUrl} with an image_url`;
    },
  );

  return results;
}

async function main() {
  const requested = process.argv.slice(2);

  console.log(`Loading installed extensions...`);
  const sources = await getInstalledSandboxedSources();
  console.log(`Loaded: ${sources.map((s) => s.id).join(', ') || '(none)'}\n`);

  // No requested ids: check everything installed, rather than a hardcoded pair — there is
  // no fixed set of sources any more for a default to name.
  const targets = requested.length > 0 ? requested : sources.map((s) => s.id);
  if (targets.length === 0) {
    console.log('Nothing installed to verify. Install a source first, then re-run.');
    return;
  }

  let anyFailed = false;

  for (const id of targets) {
    const source = sources.find((s) => s.id === id);
    console.log(`\n=== ${id} ===`);
    if (!source) {
      console.log(`  ✗ not installed`);
      anyFailed = true;
      continue;
    }

    const results = await verifySource(source);
    for (const r of results) {
      console.log(`  ${r.ok ? '✓' : '✗'} ${r.step} — ${r.detail}`);
      if (!r.ok) anyFailed = true;
    }
  }

  console.log('\n' + (anyFailed ? 'One or more checks failed.' : 'All checks passed.'));
  process.exit(anyFailed ? 1 : 0);
}

main().catch((error) => {
  console.error('Fatal error running verification:', error);
  process.exit(1);
});
