-- Indexes no query uses, or that another index already covers.
DROP INDEX IF EXISTS "mangas_author_idx";
DROP INDEX IF EXISTS "mangas_source_idx";
DROP INDEX IF EXISTS "manga_details_manga_id_idx";
DROP INDEX IF EXISTS "chapters_last_page_read_idx";
DROP INDEX IF EXISTS "caches_thumbnail_url_idx";
DROP INDEX IF EXISTS "histories_user_id_idx";

-- The history list's ordering, the status lookups and chapter-number lookups.
CREATE INDEX "histories_user_id_last_read_idx" ON "histories"("user_id", "last_read");
CREATE INDEX "downloads_status_idx" ON "downloads"("status");
CREATE INDEX "chapters_manga_id_chapter_number_idx" ON "chapters"("manga_id", "chapter_number");
