-- CreateTable
CREATE TABLE "mangas" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "slug" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "author" TEXT NOT NULL,
    "source" TEXT NOT NULL,
    "thumbnail_url" TEXT NOT NULL,
    "in_library" BOOLEAN NOT NULL DEFAULT true,
    "created_at" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" DATETIME NOT NULL
);

-- CreateTable
CREATE TABLE "manga_details" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "manga_id" TEXT NOT NULL,
    "artist" TEXT NOT NULL,
    "description" TEXT NOT NULL,
    "genres" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'ONGOING',
    "rating" REAL,
    "created_at" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" DATETIME NOT NULL,
    CONSTRAINT "manga_details_manga_id_fkey" FOREIGN KEY ("manga_id") REFERENCES "mangas" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "chapters" (
    "id" TEXT NOT NULL PRIMARY KEY,
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

-- CreateTable
CREATE TABLE "categories" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "name" TEXT NOT NULL,
    "created_at" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" DATETIME NOT NULL
);

-- CreateTable
CREATE TABLE "manga_categories" (
    "manga_id" TEXT NOT NULL,
    "category_id" TEXT NOT NULL,
    CONSTRAINT "manga_categories_category_id_fkey" FOREIGN KEY ("category_id") REFERENCES "categories" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "manga_categories_manga_id_fkey" FOREIGN KEY ("manga_id") REFERENCES "mangas" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "downloads" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "manga_id" TEXT NOT NULL,
    "chapter_id" TEXT NOT NULL,
    "source_id" TEXT NOT NULL,
    "file_path" TEXT NOT NULL,
    "downloaded_path" TEXT,
    "status" TEXT NOT NULL DEFAULT 'PENDING',
    "pages_total" INTEGER NOT NULL DEFAULT 0,
    "pages_downloaded" INTEGER NOT NULL DEFAULT 0,
    "current_page" INTEGER NOT NULL DEFAULT 0,
    "started_at" DATETIME,
    "completed_at" DATETIME,
    "created_at" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "downloads_chapter_id_fkey" FOREIGN KEY ("chapter_id") REFERENCES "chapters" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "downloads_manga_id_fkey" FOREIGN KEY ("manga_id") REFERENCES "mangas" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "histories" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "source" TEXT NOT NULL,
    "manga_id" TEXT,
    "manga_slug" TEXT NOT NULL,
    "title" TEXT,
    "thumbnail_url" TEXT,
    "chapter_id" TEXT,
    "user_id" TEXT,
    "deleted_at" DATETIME,
    "read_at" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "last_read" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "pages_read" INTEGER NOT NULL DEFAULT 0,
    "time_read" INTEGER NOT NULL DEFAULT 0,
    CONSTRAINT "histories_chapter_id_fkey" FOREIGN KEY ("chapter_id") REFERENCES "chapters" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "histories_manga_id_fkey" FOREIGN KEY ("manga_id") REFERENCES "mangas" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "histories_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "caches" (
    "manga_id" TEXT NOT NULL PRIMARY KEY,
    "thumbnail_url" TEXT,
    "sha256_url" TEXT NOT NULL,
    "updated_at" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "caches_manga_id_fkey" FOREIGN KEY ("manga_id") REFERENCES "mangas" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "manga_library" (
    "manga_id" TEXT NOT NULL PRIMARY KEY,
    "is_bookmarked" BOOLEAN NOT NULL DEFAULT false,
    "shelf_status" TEXT,
    "notification_read" BOOLEAN NOT NULL DEFAULT false,
    "created_at" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" DATETIME NOT NULL,
    CONSTRAINT "manga_library_manga_id_fkey" FOREIGN KEY ("manga_id") REFERENCES "mangas" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "update_logs" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "source_id" TEXT NOT NULL,
    "manga_id" TEXT,
    "kind" TEXT NOT NULL,
    "message" TEXT NOT NULL,
    "detail" TEXT NOT NULL,
    "created_at" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "update_logs_manga_id_fkey" FOREIGN KEY ("manga_id") REFERENCES "mangas" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "users" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "email" TEXT NOT NULL,
    "password_hash" TEXT NOT NULL,
    "display_name" TEXT,
    "created_at" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" DATETIME NOT NULL
);

-- CreateTable
CREATE TABLE "sessions" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "user_id" TEXT NOT NULL,
    "device_id" TEXT,
    "user_agent" TEXT,
    "created_at" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "expires_at" DATETIME NOT NULL,
    "last_seen_at" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "sessions_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "sessions_device_id_fkey" FOREIGN KEY ("device_id") REFERENCES "devices" ("id") ON DELETE SET NULL ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "devices" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "user_id" TEXT NOT NULL,
    "label" TEXT NOT NULL,
    "platform" TEXT NOT NULL,
    "created_at" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "last_seen_at" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "last_sync_at" DATETIME,
    CONSTRAINT "devices_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "user_library" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "user_id" TEXT NOT NULL,
    "manga_id" TEXT NOT NULL,
    "created_at" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" DATETIME NOT NULL,
    "deleted_at" DATETIME,
    CONSTRAINT "user_library_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "user_library_manga_id_fkey" FOREIGN KEY ("manga_id") REFERENCES "mangas" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "user_manga_state" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "user_id" TEXT NOT NULL,
    "manga_id" TEXT NOT NULL,
    "is_bookmarked" BOOLEAN NOT NULL DEFAULT false,
    "shelf_status" TEXT,
    "score" INTEGER,
    "notification_read" BOOLEAN NOT NULL DEFAULT false,
    "updated_at" DATETIME NOT NULL,
    CONSTRAINT "user_manga_state_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "user_manga_state_manga_id_fkey" FOREIGN KEY ("manga_id") REFERENCES "mangas" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "user_chapter_state" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "user_id" TEXT NOT NULL,
    "chapter_id" TEXT NOT NULL,
    "is_read" BOOLEAN NOT NULL DEFAULT false,
    "is_bookmark" BOOLEAN NOT NULL DEFAULT false,
    "last_page_read" INTEGER NOT NULL DEFAULT 0,
    "updated_at" DATETIME NOT NULL,
    CONSTRAINT "user_chapter_state_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "user_chapter_state_chapter_id_fkey" FOREIGN KEY ("chapter_id") REFERENCES "chapters" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "user_manga_category" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "user_id" TEXT NOT NULL,
    "manga_id" TEXT NOT NULL,
    "category_id" TEXT NOT NULL,
    "created_at" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" DATETIME NOT NULL,
    "deleted_at" DATETIME,
    CONSTRAINT "user_manga_category_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "user_manga_category_manga_id_fkey" FOREIGN KEY ("manga_id") REFERENCES "mangas" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "user_manga_category_category_id_fkey" FOREIGN KEY ("category_id") REFERENCES "categories" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "extension_repositories" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "url" TEXT NOT NULL,
    "name" TEXT,
    "added_at" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "last_fetched_at" DATETIME,
    "enabled" BOOLEAN NOT NULL DEFAULT true
);

-- CreateTable
CREATE TABLE "installed_extensions" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "repository_id" TEXT NOT NULL,
    "source_key" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "lang" TEXT NOT NULL,
    "base_url" TEXT NOT NULL,
    "is_nsfw" BOOLEAN NOT NULL DEFAULT false,
    "allowed_hosts" JSONB NOT NULL,
    "version" TEXT NOT NULL,
    "entry_url" TEXT NOT NULL,
    "source_code_hash" TEXT NOT NULL,
    "installed_at" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" DATETIME NOT NULL,
    "enabled" BOOLEAN NOT NULL DEFAULT true,
    CONSTRAINT "installed_extensions_repository_id_fkey" FOREIGN KEY ("repository_id") REFERENCES "extension_repositories" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "tracker_accounts" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "user_id" TEXT NOT NULL,
    "tracker" TEXT NOT NULL,
    "access_token" TEXT NOT NULL,
    "refresh_token" TEXT,
    "expires_at" DATETIME,
    "tracker_user_id" TEXT NOT NULL,
    "tracker_username" TEXT NOT NULL,
    "created_at" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" DATETIME NOT NULL,
    CONSTRAINT "tracker_accounts_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "tracker_links" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "user_id" TEXT NOT NULL,
    "manga_id" TEXT NOT NULL,
    "tracker" TEXT NOT NULL,
    "tracker_media_id" TEXT NOT NULL,
    "sync_enabled" BOOLEAN NOT NULL DEFAULT true,
    "last_synced_at" DATETIME,
    "created_at" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" DATETIME NOT NULL,
    CONSTRAINT "tracker_links_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "tracker_links_manga_id_fkey" FOREIGN KEY ("manga_id") REFERENCES "mangas" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateIndex
CREATE UNIQUE INDEX "mangas_slug_key" ON "mangas"("slug");

-- CreateIndex
CREATE INDEX "mangas_title_idx" ON "mangas"("title");

-- CreateIndex
CREATE INDEX "mangas_author_idx" ON "mangas"("author");

-- CreateIndex
CREATE INDEX "mangas_source_idx" ON "mangas"("source");

-- CreateIndex
CREATE INDEX "mangas_slug_idx" ON "mangas"("slug");

-- CreateIndex
CREATE INDEX "mangas_updated_at_idx" ON "mangas"("updated_at");

-- CreateIndex
CREATE INDEX "mangas_in_library_idx" ON "mangas"("in_library");

-- CreateIndex
CREATE UNIQUE INDEX "manga_details_manga_id_key" ON "manga_details"("manga_id");

-- CreateIndex
CREATE INDEX "manga_details_manga_id_idx" ON "manga_details"("manga_id");

-- CreateIndex
CREATE INDEX "chapters_last_page_read_idx" ON "chapters"("last_page_read");

-- CreateIndex
CREATE INDEX "chapters_manga_id_idx" ON "chapters"("manga_id");

-- CreateIndex
CREATE UNIQUE INDEX "chapters_id_manga_id_scanlator_key" ON "chapters"("id", "manga_id", "scanlator");

-- CreateIndex
CREATE UNIQUE INDEX "categories_name_key" ON "categories"("name");

-- CreateIndex
CREATE INDEX "manga_categories_category_id_fkey" ON "manga_categories"("category_id");

-- CreateIndex
CREATE UNIQUE INDEX "manga_categories_manga_id_category_id_key" ON "manga_categories"("manga_id", "category_id");

-- CreateIndex
CREATE INDEX "downloads_chapter_id_fkey" ON "downloads"("chapter_id");

-- CreateIndex
CREATE INDEX "downloads_manga_id_fkey" ON "downloads"("manga_id");

-- CreateIndex
CREATE INDEX "histories_manga_slug_idx" ON "histories"("manga_slug");

-- CreateIndex
CREATE INDEX "histories_chapter_id_idx" ON "histories"("chapter_id");

-- CreateIndex
CREATE INDEX "histories_manga_id_fkey" ON "histories"("manga_id");

-- CreateIndex
CREATE INDEX "histories_user_id_idx" ON "histories"("user_id");

-- CreateIndex
CREATE INDEX "caches_sha256_url_idx" ON "caches"("sha256_url");

-- CreateIndex
CREATE INDEX "caches_thumbnail_url_idx" ON "caches"("thumbnail_url");

-- CreateIndex
CREATE INDEX "manga_library_is_bookmarked_idx" ON "manga_library"("is_bookmarked");

-- CreateIndex
CREATE INDEX "manga_library_shelf_status_idx" ON "manga_library"("shelf_status");

-- CreateIndex
CREATE INDEX "update_logs_source_id_idx" ON "update_logs"("source_id");

-- CreateIndex
CREATE INDEX "update_logs_manga_id_idx" ON "update_logs"("manga_id");

-- CreateIndex
CREATE INDEX "update_logs_created_at_idx" ON "update_logs"("created_at");

-- CreateIndex
CREATE UNIQUE INDEX "users_email_key" ON "users"("email");

-- CreateIndex
CREATE INDEX "sessions_user_id_idx" ON "sessions"("user_id");

-- CreateIndex
CREATE INDEX "sessions_expires_at_idx" ON "sessions"("expires_at");

-- CreateIndex
CREATE INDEX "devices_user_id_idx" ON "devices"("user_id");

-- CreateIndex
CREATE INDEX "user_library_manga_id_fkey" ON "user_library"("manga_id");

-- CreateIndex
CREATE INDEX "user_library_user_id_updated_at_idx" ON "user_library"("user_id", "updated_at");

-- CreateIndex
CREATE UNIQUE INDEX "user_library_user_id_manga_id_key" ON "user_library"("user_id", "manga_id");

-- CreateIndex
CREATE INDEX "user_manga_state_manga_id_fkey" ON "user_manga_state"("manga_id");

-- CreateIndex
CREATE INDEX "user_manga_state_user_id_updated_at_idx" ON "user_manga_state"("user_id", "updated_at");

-- CreateIndex
CREATE UNIQUE INDEX "user_manga_state_user_id_manga_id_key" ON "user_manga_state"("user_id", "manga_id");

-- CreateIndex
CREATE INDEX "user_chapter_state_chapter_id_fkey" ON "user_chapter_state"("chapter_id");

-- CreateIndex
CREATE INDEX "user_chapter_state_user_id_updated_at_idx" ON "user_chapter_state"("user_id", "updated_at");

-- CreateIndex
CREATE UNIQUE INDEX "user_chapter_state_user_id_chapter_id_key" ON "user_chapter_state"("user_id", "chapter_id");

-- CreateIndex
CREATE INDEX "user_manga_category_manga_id_fkey" ON "user_manga_category"("manga_id");

-- CreateIndex
CREATE INDEX "user_manga_category_category_id_fkey" ON "user_manga_category"("category_id");

-- CreateIndex
CREATE INDEX "user_manga_category_user_id_updated_at_idx" ON "user_manga_category"("user_id", "updated_at");

-- CreateIndex
CREATE UNIQUE INDEX "user_manga_category_user_id_manga_id_category_id_key" ON "user_manga_category"("user_id", "manga_id", "category_id");

-- CreateIndex
CREATE UNIQUE INDEX "extension_repositories_url_key" ON "extension_repositories"("url");

-- CreateIndex
CREATE INDEX "installed_extensions_repository_id_idx" ON "installed_extensions"("repository_id");

-- CreateIndex
CREATE UNIQUE INDEX "installed_extensions_repository_id_source_key_key" ON "installed_extensions"("repository_id", "source_key");

-- CreateIndex
CREATE UNIQUE INDEX "tracker_accounts_user_id_tracker_key" ON "tracker_accounts"("user_id", "tracker");

-- CreateIndex
CREATE INDEX "tracker_links_manga_id_idx" ON "tracker_links"("manga_id");

-- CreateIndex
CREATE UNIQUE INDEX "tracker_links_user_id_manga_id_tracker_key" ON "tracker_links"("user_id", "manga_id", "tracker");
