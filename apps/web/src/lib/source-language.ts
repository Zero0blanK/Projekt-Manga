import type { CatalogEntry } from './extensions-store';

export function normalizeSourceLanguage(code: string): string {
  const normalized = code.trim().toLowerCase().replaceAll('_', '-');
  if (normalized === 'jp') return 'ja';
  if (['all', 'multi', 'multilingual'].includes(normalized)) return 'all';
  return normalized || 'und';
}

export function sourceLanguageGroup(code: string): string {
  const normalized = normalizeSourceLanguage(code);
  return normalized === 'all' ? 'multi' : normalized.split('-')[0];
}

export function sourceLanguageName(code: string): string {
  const normalized = normalizeSourceLanguage(code);
  if (normalized === 'all') return 'Multilingual';
  if (normalized === 'und') return 'Unknown language';
  try {
    return new Intl.DisplayNames(['en'], { type: 'language' }).of(normalized) ?? code;
  } catch {
    return code;
  }
}

/** Correct known UTF-8 mojibake in older repository/installed source labels only. */
export function repairSourceName(value: string): string {
  return value
    .replaceAll('â€”', '—')
    .replaceAll('â€“', '–')
    .replaceAll('Ã±', 'ñ')
    .replaceAll('Ã§', 'ç')
    .replaceAll('Ãª', 'ê');
}

export function sourceLanguageEditions(
  sourceKey: string,
  repositoryId: string | undefined,
  entries: CatalogEntry[],
): CatalogEntry[] {
  const current = entries.find(
    (item) =>
      item.entry.source_key === sourceKey && (!repositoryId || item.repositoryId === repositoryId),
  );
  const repository = repositoryId ?? current?.repositoryId;
  if (!repository) return [];
  const family = (item: CatalogEntry) =>
    item.entry.family_key ??
    (item.entry.source_key === 'mangadex' || item.entry.source_key.startsWith('mangadex-')
      ? 'mangadex'
      : item.entry.source_key);
  const familyKey = current
    ? family(current)
    : sourceKey === 'mangadex' || sourceKey.startsWith('mangadex-')
      ? 'mangadex'
      : sourceKey;
  return entries
    .filter((item) => item.repositoryId === repository && family(item) === familyKey)
    .sort(
      (a, b) =>
        sourceLanguageName(a.entry.lang).localeCompare(sourceLanguageName(b.entry.lang)) ||
        a.entry.source_key.localeCompare(b.entry.source_key),
    );
}
