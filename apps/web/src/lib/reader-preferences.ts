'use client';

import type { MangaChapterRecord } from '@projekt-manga/api-client';
import {
  COLOR_FILTERS,
  READER_TINTS,
  TINT_STRENGTH_MAX,
  TINT_STRENGTH_MIN,
} from '@/lib/page-image';

export const TAP_ACTIONS = [
  'Direction',
  'Opposite',
  'Forward',
  'Back',
  'Controls',
  'None',
] as const;
export type TapAction = (typeof TAP_ACTIONS)[number];
export type ReaderPreset = {
  name: string;
  pageLayout: string;
  readingDirection: string;
  zoomBehavior: string;
  brightness: number;
  stripGap: number;
  pagePrefetchAhead: number;
  chapterPrefetchCount: number;
  /** Absent on presets saved before colour filters existed; they leave the filter alone. */
  colorFilter?: string;
  /** Absent on presets saved before tints existed, likewise. */
  tint?: string;
  tintStrength?: number;
};
export function parseReaderPresets(raw: unknown): ReaderPreset[] {
  if (!Array.isArray(raw) || raw.length > 30) return [];
  if (
    !raw.every(
      (item) =>
        item &&
        typeof item === 'object' &&
        typeof item.name === 'string' &&
        item.name.trim().length > 0 &&
        item.name.length <= 60 &&
        ['Single page', 'Two-page spread', 'Long strip'].includes(item.pageLayout) &&
        ['Right to left', 'Left to right', 'Vertical (webtoon)'].includes(item.readingDirection) &&
        ['Smart', 'Fit width', 'Fit height', 'Original'].includes(item.zoomBehavior) &&
        Number.isFinite(item.brightness) &&
        item.brightness >= 30 &&
        item.brightness <= 100 &&
        [0, 4, 8, 16, 24].includes(item.stripGap) &&
        [0, 2, 4, 8, 12].includes(item.pagePrefetchAhead) &&
        [1, 2, 3].includes(item.chapterPrefetchCount) &&
        (item.colorFilter === undefined ||
          (COLOR_FILTERS as readonly string[]).includes(item.colorFilter)) &&
        (item.tint === undefined || READER_TINTS.some((tint) => tint.label === item.tint)) &&
        (item.tintStrength === undefined ||
          (Number.isFinite(item.tintStrength) &&
            item.tintStrength >= TINT_STRENGTH_MIN &&
            item.tintStrength <= TINT_STRENGTH_MAX)),
    )
  )
    return [];
  return raw as ReaderPreset[];
}
export function parseReaderOverride(raw: unknown): ReaderPreset | null {
  if (raw === null) return null;
  return parseReaderPresets([raw])[0] ?? null;
}
export function parsePreferredGroup(raw: unknown): string {
  return typeof raw === 'string' && raw.length <= 200 ? raw : '';
}
export function parseChapterParam(raw: string | null): number | undefined {
  if (raw === null || !raw.trim()) return undefined;
  const value = Number(raw);
  return Number.isFinite(value) && value >= 0 ? value : undefined;
}
export function selectChapterRelease(
  chapters: MangaChapterRecord[],
  number: number,
  preferredGroup: string,
  explicitId?: string | null,
) {
  if (explicitId) return chapters.find((record) => record.id === explicitId);
  const choices = chapters.filter((record) => record.chapter_number === number);
  return (
    choices.find((record) => preferredGroup && record.scanlator === preferredGroup) ?? choices[0]
  );
}
export type PageNote = {
  source: string;
  mangaId: string;
  chapterId: string;
  page: number;
  text: string;
};
export function parsePageNotes(raw: unknown): PageNote[] {
  if (!Array.isArray(raw) || raw.length > 5000) return [];
  if (
    !raw.every(
      (item) =>
        item &&
        typeof item === 'object' &&
        ['source', 'mangaId', 'chapterId'].every(
          (key) => typeof item[key] === 'string' && item[key].length > 0 && item[key].length <= 500,
        ) &&
        Number.isInteger(item.page) &&
        item.page >= 1 &&
        item.page <= 100000 &&
        typeof item.text === 'string' &&
        item.text.length <= 10000,
    )
  )
    return [];
  return raw as PageNote[];
}
