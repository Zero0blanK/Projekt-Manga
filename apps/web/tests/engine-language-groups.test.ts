import { describe, expect, it } from 'vitest';
import type { DisplaySource } from '@/lib/manga-data';
import { collapseEngineLanguages } from '@/lib/engine-language-groups';

const engine = (id: string, name: string, lang: string) =>
  ({ id, name, lang, provider: 'suwayomi' }) as DisplaySource;
const own = (id: string, name: string, lang: string) =>
  ({ id, name, lang, provider: 'sandboxed' }) as DisplaySource;

const sources = [
  engine('s:en', 'MangaDex', 'en'),
  engine('s:ja', 'MangaDex', 'ja'),
  engine('s:fr', 'MangaDex', 'fr'),
  engine('s:one', 'Comick', 'en'),
  own('geko', 'MangaGeko', 'en'),
];

describe("an engine extension's languages", () => {
  it("show as one card, in the reader's language when nothing is chosen", () => {
    const { sources: shown, languagesOf } = collapseEngineLanguages(
      sources,
      {},
      {
        preferredLanguage: 'ja-JP',
      },
    );
    expect(shown.map((source) => source.id)).toEqual(['s:ja', 's:one', 'geko']);
    expect(languagesOf.get('s:ja')?.map((source) => source.lang)).toEqual(['en', 'ja', 'fr']);
    // A single-language extension and the repositories' sources are untouched.
    expect(languagesOf.has('s:one')).toBe(false);
  });

  it('follow the language chosen for the extension', () => {
    const { sources: shown } = collapseEngineLanguages(
      sources,
      { mangadex: 's:fr' },
      { preferredLanguage: 'en' },
    );
    expect(shown[0].id).toBe('s:fr');
  });

  it('stay in the chosen language under the Multilingual filter', () => {
    const { sources: shown } = collapseEngineLanguages(
      sources,
      { mangadex: 's:fr' },
      { language: 'multi' },
    );
    expect(shown.map((source) => source.id)).toContain('s:fr');
  });

  it("show the filter's language, or leave the extension out without it", () => {
    expect(
      collapseEngineLanguages(sources, { mangadex: 's:fr' }, { language: 'ja' }).sources.map(
        (source) => source.id,
      ),
    ).toContain('s:ja');
    expect(
      collapseEngineLanguages(sources, {}, { language: 'de' }).sources.map((source) => source.id),
    ).not.toContain('s:en');
  });
});
