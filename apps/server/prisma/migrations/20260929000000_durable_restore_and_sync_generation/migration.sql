ALTER TABLE "users" ADD COLUMN "sync_generation" INTEGER NOT NULL DEFAULT 0;

CREATE TABLE "restore_jobs" (
  "id" TEXT NOT NULL PRIMARY KEY,
  "owner" TEXT NOT NULL,
  "state" TEXT NOT NULL,
  "payload" TEXT NOT NULL,
  "result" TEXT,
  "created_at" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX "restore_jobs_owner_state_idx" ON "restore_jobs"("owner", "state");
