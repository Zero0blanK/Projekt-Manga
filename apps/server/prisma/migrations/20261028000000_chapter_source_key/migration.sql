-- Chapters get an app-owned identity (see schema.prisma). Existing ids are kept as the app
-- id, so nothing that references a chapter is rewritten, and the source's id moves into
-- source_chapter_key, scoped by the title's source + slug. Ids were globally unique
-- before this, so the new unique index cannot collide on existing rows.
-- Placeholders and orphans with no manga row take their title from the newest history
-- row that points at them, and fall back to '' when nothing names one.
PRAGMA defer_foreign_keys=ON;
PRAGMA foreign_keys=OFF;
CREATE TABLE "new_chapters" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "source" TEXT NOT NULL,
    "manga_slug" TEXT NOT NULL,
    "source_chapter_key" TEXT NOT NULL,
    "manga_id" TEXT,
    "url" TEXT NOT NULL,
    "name" TEXT,
    "scanlator" TEXT,
    "is_read" BOOLEAN NOT NULL DEFAULT false,
    "is_bookmark" BOOLEAN NOT NULL DEFAULT false,
    "chapter_number" REAL NOT NULL,
    "last_page_read" INTEGER NOT NULL DEFAULT 0,
    "page_count" INTEGER,
    "fetched_at" DATETIME,
    "release_date" DATETIME,
    "created_at" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" DATETIME NOT NULL,
    CONSTRAINT "chapters_manga_id_fkey" FOREIGN KEY ("manga_id") REFERENCES "mangas" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);
INSERT INTO "new_chapters" ("id", "source", "manga_slug", "source_chapter_key", "chapter_number", "created_at", "fetched_at", "is_bookmark", "is_read", "last_page_read", "manga_id", "name", "page_count", "release_date", "scanlator", "updated_at", "url")
SELECT
    c."id",
    COALESCE(
        m."source",
        (SELECT h."source" FROM "histories" h WHERE h."chapter_id" = c."id" ORDER BY h."last_read" DESC, h."id" DESC LIMIT 1),
        ''
    ),
    COALESCE(
        m."slug",
        (SELECT h."manga_slug" FROM "histories" h WHERE h."chapter_id" = c."id" ORDER BY h."last_read" DESC, h."id" DESC LIMIT 1),
        ''
    ),
    c."id",
    c."chapter_number", c."created_at", c."fetched_at", c."is_bookmark", c."is_read", c."last_page_read", c."manga_id", c."name", c."page_count", c."release_date", c."scanlator", c."updated_at", c."url"
FROM "chapters" c
LEFT JOIN "mangas" m ON m."id" = c."manga_id";
DROP TABLE "chapters";
ALTER TABLE "new_chapters" RENAME TO "chapters";
CREATE INDEX "chapters_last_page_read_idx" ON "chapters"("last_page_read");
CREATE INDEX "chapters_manga_id_idx" ON "chapters"("manga_id");
CREATE UNIQUE INDEX "chapters_source_manga_slug_source_chapter_key_key" ON "chapters"("source", "manga_slug", "source_chapter_key");
PRAGMA foreign_keys=ON;
PRAGMA defer_foreign_keys=OFF;
