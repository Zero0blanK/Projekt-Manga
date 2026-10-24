DROP INDEX "mangas_slug_key";
CREATE UNIQUE INDEX "mangas_source_slug_key" ON "mangas"("source", "slug");
