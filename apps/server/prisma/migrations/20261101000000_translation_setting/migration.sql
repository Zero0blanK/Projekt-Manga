-- A reader's own machine-translation service (see schema.prisma, model
-- translation_setting). The API key is stored only encrypted.
CREATE TABLE "translation_settings" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "user_id" TEXT,
    "provider" TEXT NOT NULL,
    "url" TEXT,
    "key_encrypted" TEXT,
    "created_at" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" DATETIME NOT NULL,
    CONSTRAINT "translation_settings_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateIndex
CREATE UNIQUE INDEX "translation_settings_user_id_key" ON "translation_settings"("user_id");
