ALTER TABLE "histories" ADD COLUMN "sync_updated_at" DATETIME;
UPDATE "histories" SET "sync_updated_at" = CURRENT_TIMESTAMP;
CREATE INDEX "histories_user_id_sync_updated_at_id_idx" ON "histories"("user_id", "sync_updated_at", "id");
