-- Categories were one vocabulary shared by every account, keyed by a slug of the name.
-- Each account now owns its list. Existing rows stay as the anonymous list (user_id NULL,
-- same ids), and each account gets a private copy of the categories it has assignments
-- for, with those assignments repointed. Empty categories stay anonymous only: nothing
-- records who created them.
PRAGMA defer_foreign_keys=ON;
PRAGMA foreign_keys=OFF;
CREATE TABLE "new_categories" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "user_id" TEXT,
    "name" TEXT NOT NULL,
    "key" TEXT NOT NULL,
    "created_at" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" DATETIME NOT NULL,
    CONSTRAINT "categories_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);
-- The old id was already the canonical form of the name, so it is the key.
INSERT INTO "new_categories" ("id", "user_id", "name", "key", "created_at", "updated_at")
SELECT "id", NULL, "name", "id", "created_at", "updated_at" FROM "categories";
INSERT INTO "new_categories" ("id", "user_id", "name", "key", "created_at", "updated_at")
SELECT 'c' || lower(hex(randomblob(12))), owners."user_id", c."name", c."id", c."created_at", c."updated_at"
FROM (SELECT DISTINCT "user_id", "category_id" FROM "user_manga_category") AS owners
JOIN "categories" AS c ON c."id" = owners."category_id";
UPDATE "user_manga_category" SET "category_id" = (
    SELECT n."id" FROM "new_categories" AS n
    WHERE n."user_id" = "user_manga_category"."user_id" AND n."key" = "user_manga_category"."category_id"
);
DROP TABLE "categories";
ALTER TABLE "new_categories" RENAME TO "categories";
CREATE UNIQUE INDEX "categories_user_id_key_key" ON "categories"("user_id", "key");
-- A unique index treats NULLs as distinct, so the anonymous list needs its own.
CREATE UNIQUE INDEX "categories_anonymous_key_key" ON "categories"("key") WHERE "user_id" IS NULL;
PRAGMA foreign_key_check;
PRAGMA foreign_keys=ON;
PRAGMA defer_foreign_keys=OFF;
