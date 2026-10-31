export interface MangaHistory {
  source: string;
  manga_id?: string;
  manga_slug: string;
  /** Native source identifier used by fetchMangaDetails; may differ from manga_slug. */
  source_manga_id?: string;
  /** Captured at read time so source reads (which create no manga row) still show a name. */
  title?: string;
  /** The source's own id for the chapter, within `source` + `manga_slug`. */
  source_chapter_key?: string;
  /** What clients from before keys send instead: the chapter's row id on the server. */
  chapter_id?: string;
  thumbnail_url?: string;
  pages_read: number;
  time_read?: number; // in milliseconds
  read_at?: Date;
  last_read?: Date;
}

export interface ChapterHistory {
  id: string;
  url: string;
  name: string;
  chapter_number: number;
  scanlator?: string | null;
  release_date: string;
  last_page_read: number;
  page_count: number;
}
