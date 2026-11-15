/**
 * Names an external backup import saves things under: in this browser's storage, and as the
 * source of a title whose source isn't installed (`imported:<name>`).
 *
 * Earlier versions saved them under other names. Those are read too, so a title or pending
 * read state saved then is still recognised, and storage is moved to the new name the first
 * time it's read. They are never written.
 */

export const UNMATCHED_SOURCE_PREFIX = 'imported:';
const FORMER_SOURCE_PREFIXES = ['mihon:'];

export const EXTRAS_STORAGE_KEY = 'projekt-manga-external-import';
export const CHAPTER_STATE_STORAGE_KEY = 'projekt-manga-external-chapter-state';
const FORMER_STORAGE_KEYS: Record<string, string> = {
  [EXTRAS_STORAGE_KEY]: 'projekt-manga-mihon-import',
  [CHAPTER_STATE_STORAGE_KEY]: 'projekt-manga-mihon-chapter-state',
};

/** The source name of a title an import kept without a source, or null. */
export function sourceNameOfUnmatched(sourceId: string): string | null {
  for (const prefix of [UNMATCHED_SOURCE_PREFIX, ...FORMER_SOURCE_PREFIXES]) {
    if (sourceId.startsWith(prefix)) return sourceId.slice(prefix.length);
  }
  return null;
}

/** Reads `key` from storage, moving a value saved under its former name across first. */
export function readStored(key: string): string | null {
  const current = localStorage.getItem(key);
  if (current !== null) return current;
  const former = FORMER_STORAGE_KEYS[key];
  const saved = former ? localStorage.getItem(former) : null;
  if (former && saved !== null) {
    localStorage.setItem(key, saved);
    localStorage.removeItem(former);
  }
  return saved;
}
