-- One override per title per identity, and one primary per linked title per identity, were
-- only kept by repository code. Anything that slipped through is settled here first: the
-- newest override wins but keeps a custom cover if only an older row had one, and a linked
-- title stays under its highest-priority primary. Window partitions group NULLs together,
-- which is what the anonymous identity needs.
UPDATE "manga_overrides" SET "cover_path" = (
    SELECT d."cover_path" FROM "manga_overrides" AS d
    WHERE d."manga_id" = "manga_overrides"."manga_id"
      AND d."user_id" IS "manga_overrides"."user_id"
      AND d."cover_path" IS NOT NULL
    ORDER BY d."updated_at" DESC, d."id" DESC
    LIMIT 1
) WHERE "cover_path" IS NULL;
DELETE FROM "manga_overrides" WHERE "id" NOT IN (
    SELECT "id" FROM (
        SELECT "id", ROW_NUMBER() OVER (
            PARTITION BY "manga_id", "user_id" ORDER BY "updated_at" DESC, "id" DESC
        ) AS "rank" FROM "manga_overrides"
    ) WHERE "rank" = 1
);
DELETE FROM "manga_links" WHERE "id" NOT IN (
    SELECT "id" FROM (
        SELECT "id", ROW_NUMBER() OVER (
            PARTITION BY "user_id", "linked_id" ORDER BY "priority" ASC, "created_at" ASC, "id" ASC
        ) AS "rank" FROM "manga_links"
    ) WHERE "rank" = 1
);
DROP INDEX IF EXISTS "manga_overrides_manga_id_user_id_idx";
DROP INDEX IF EXISTS "manga_links_user_id_linked_id_idx";
CREATE UNIQUE INDEX "manga_overrides_manga_id_user_id_key" ON "manga_overrides"("manga_id", "user_id");
CREATE UNIQUE INDEX "manga_overrides_anonymous_manga_id_key" ON "manga_overrides"("manga_id") WHERE "user_id" IS NULL;
CREATE UNIQUE INDEX "manga_links_user_id_linked_id_key" ON "manga_links"("user_id", "linked_id");
CREATE UNIQUE INDEX "manga_links_anonymous_linked_id_key" ON "manga_links"("linked_id") WHERE "user_id" IS NULL;
