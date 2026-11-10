-- How many times the worker has started each restore. A job still running at startup was
-- cut short by a crash. It is resumed once, then failed, so a restore that itself brings
-- the server down can't do so on every start. Existing rows start at 0.
ALTER TABLE "restore_jobs" ADD COLUMN "attempts" INTEGER NOT NULL DEFAULT 0;
