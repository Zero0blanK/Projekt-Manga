-- A reader's own edits to a title, laid over the shared catalog on read (see
-- schema.prisma). No unique index on (manga_id, user_id): SQLite treats NULLs as distinct,
-- so the anonymous row's uniqueness is enforced in mangaOverride.repository instead.
CREATE TABLE "manga_overrides" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "manga_id" TEXT NOT NULL,
    "user_id" TEXT,
    "title" TEXT,
    "author" TEXT,
    "description" TEXT,
    "status" TEXT,
    "cover_path" TEXT,
    "updated_at" DATETIME NOT NULL,
    CONSTRAINT "manga_overrides_manga_id_fkey" FOREIGN KEY ("manga_id") REFERENCES "mangas" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "manga_overrides_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateIndex
CREATE INDEX "manga_overrides_manga_id_user_id_idx" ON "manga_overrides"("manga_id", "user_id");

-- CreateIndex
CREATE INDEX "manga_overrides_user_id_idx" ON "manga_overrides"("user_id");
