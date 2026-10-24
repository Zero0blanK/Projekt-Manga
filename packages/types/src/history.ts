export interface MangaHistory {
  source: string;
  manga_id?: string;
  manga_slug: string;
  /** Native source identifier used by fetchMangaDetails; may differ from manga_slug. */
  source_manga_id?: string;
  /** Captured at read time so source reads (which create no manga row) still show a name. */
  title?: string;
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
