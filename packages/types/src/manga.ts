import type { Chapters } from './extension.js';

export interface AddMangaPayload {
  source: string;
  title: string;
  slug: string;
  author: string;
  thumbnail_url: string;
  artist?: string;
  description: string;
  genres: string;
  /** Raw, unnormalized status text as the source reported it (e.g. "Ongoing", "finished")
   * — not yet a `MangaStatus`. Normalized server-side by `toMangaStatus()` in
   * apps/server/src/repositories/manga.repository.ts before it's persisted. */
  status: string;
  rating?: number;
  /** Whether this add puts the title in the library. Defaults to true; pass false to
   * create a source-backed row for previewing/downloading without adding it. */
  in_library?: boolean;
  chapters: Chapters[];
}

export interface MangaDexTag {
  id: string;
  type: string;
  attributes: {
    name: Record<string, string>;
    group: string;
  };
}

export interface GetMangaOptions {
  sortBy?: 'title' | 'dateAdded' | 'recentlyRead';
  sortOrder?: 'asc' | 'desc';
}
