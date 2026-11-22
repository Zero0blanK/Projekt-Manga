import type { DisplaySource } from '@/lib/manga-data';
import { sourceLanguageGroup } from '@/lib/source-language';

/**
 * A multilingual extension from the extension engine installs one source per language,
 * all with the extension's name ("MangaDex" in English, in Japanese…). Installed sources
 * shows them as one card, in the language chosen under the card's Display languages,
 * rather than one card per language.
 */

/** Which of an extension's languages each card shows: group key → source id. */
export type EngineLanguageChoices = Record<string, string>;

export const parseEngineLanguageChoices = (value: unknown): EngineLanguageChoices =>
  value && typeof value === 'object' && !Array.isArray(value)
    ? Object.fromEntries(
        Object.entries(value as Record<string, unknown>).filter(
          (entry): entry is [string, string] => typeof entry[1] === 'string',
        ),
      )
    : {};

/** The extension an engine source belongs to, by its name. */
export const engineGroupKey = (source: Pick<DisplaySource, 'name'>) =>
  source.name.toLocaleLowerCase().replace(/[^\p{L}\p{N}]/gu, '');

/**
 * The engine's sources with each extension's languages folded into one: the language
 * chosen for it, else the reader's own language, else its first. With a language filter
 * on, only that language's sources are candidates. `languagesOf` gives, for each source
 * shown for a group, every language of that extension.
 */
export function collapseEngineLanguages(
  sources: readonly DisplaySource[],
  choices: EngineLanguageChoices,
  options: { language?: string; preferredLanguage?: string } = {},
): { sources: DisplaySource[]; languagesOf: Map<string, DisplaySource[]> } {
  const groups = new Map<string, DisplaySource[]>();
  for (const source of sources) {
    if (source.provider !== 'suwayomi') continue;
    const key = engineGroupKey(source);
    groups.set(key, [...(groups.get(key) ?? []), source]);
  }

  const preferred = (options.preferredLanguage ?? '').toLowerCase().split('-')[0];
  const shown: DisplaySource[] = [];
  const languagesOf = new Map<string, DisplaySource[]>();
  for (const source of sources) {
    const members = source.provider === 'suwayomi' ? groups.get(engineGroupKey(source)) : null;
    if (!members || members.length < 2) {
      shown.push(source);
      continue;
    }
    // Each group is placed once, where its first source was.
    if (members[0] !== source) continue;
    const key = engineGroupKey(source);
    // A grouped extension is multilingual: that filter keeps all of its languages.
    const candidates =
      options.language && options.language !== 'multi'
        ? members.filter((member) => sourceLanguageGroup(member.lang) === options.language)
        : members;
    if (candidates.length === 0) continue;
    const chosen = candidates.find((member) => member.id === choices[key]);
    const inPreferred = preferred
      ? candidates.find((member) => member.lang.toLowerCase().split('-')[0] === preferred)
      : undefined;
    const pick = chosen ?? inPreferred ?? candidates[0];
    shown.push(pick);
    languagesOf.set(pick.id, members);
  }
  return { sources: shown, languagesOf };
}
