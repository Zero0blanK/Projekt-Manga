-- Destinations for new-chapter alerts outside the app (see schema.prisma, model
-- notification_channel). The destination is stored only encrypted.
CREATE TABLE "notification_channels" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "user_id" TEXT,
    "kind" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "target_encrypted" TEXT NOT NULL,
    "enabled" BOOLEAN NOT NULL DEFAULT true,
    "created_at" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "last_sent_at" DATETIME,
    "last_error" TEXT,
    CONSTRAINT "notification_channels_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateIndex
CREATE INDEX "notification_channels_user_id_idx" ON "notification_channels"("user_id");
