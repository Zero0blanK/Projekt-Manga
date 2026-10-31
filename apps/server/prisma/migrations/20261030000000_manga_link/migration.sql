-- One title read across sources (see schema.prisma, model manga_link). No unique index on
-- (user_id, linked_id): SQLite treats NULLs as distinct, so one primary per linked title is
-- enforced in mangaLink.repository instead.
CREATE TABLE "manga_links" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "user_id" TEXT,
    "primary_id" TEXT NOT NULL,
    "linked_id" TEXT NOT NULL,
    "priority" INTEGER NOT NULL DEFAULT 0,
    "created_at" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "manga_links_primary_id_fkey" FOREIGN KEY ("primary_id") REFERENCES "mangas" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "manga_links_linked_id_fkey" FOREIGN KEY ("linked_id") REFERENCES "mangas" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "manga_links_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateIndex
CREATE INDEX "manga_links_user_id_primary_id_idx" ON "manga_links"("user_id", "primary_id");

-- CreateIndex
CREATE INDEX "manga_links_user_id_linked_id_idx" ON "manga_links"("user_id", "linked_id");

-- CreateIndex
CREATE INDEX "manga_links_linked_id_idx" ON "manga_links"("linked_id");
