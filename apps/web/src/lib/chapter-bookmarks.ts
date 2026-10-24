'use client';

import { useMemo } from 'react';
import { EMPTY_IDS, parseIdList, useProfilePreference } from './profile-preferences';

function parseChapterIds(value: unknown) {
  return parseIdList(value, 50000);
}

export function useChapterBookmarks(
  chapters: ReadonlyArray<{ id: string; is_bookmark?: boolean }>,
) {
  const [included, setIncluded] = useProfilePreference(
    'chapterBookmarks',
    parseChapterIds,
    EMPTY_IDS,
  );
  const [excluded, setExcluded] = useProfilePreference(
    'chapterBookmarkExclusions',
    parseChapterIds,
    EMPTY_IDS,
  );
  const inherited = useMemo(
    () => new Set(chapters.filter((ch) => ch.is_bookmark).map((ch) => ch.id)),
    [chapters],
  );
  const includedIds = useMemo(() => new Set(included), [included]);
  const excludedIds = useMemo(() => new Set(excluded), [excluded]);
  const isBookmarked = (id: string) =>
    !excludedIds.has(id) && (includedIds.has(id) || inherited.has(id));
  const toggle = (id: string) => {
    const next = !isBookmarked(id);
    setIncluded((current) =>
      next ? [...new Set([...current, id])] : current.filter((value) => value !== id),
    );
    setExcluded((current) =>
      !next && inherited.has(id)
        ? [...new Set([...current, id])]
        : current.filter((value) => value !== id),
    );
  };
  return { isBookmarked, toggle };
}
