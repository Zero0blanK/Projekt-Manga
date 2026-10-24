-- Device-reported edit time for last-write-wins (see schema.prisma).
ALTER TABLE "user_library" ADD COLUMN "edited_at" DATETIME;
ALTER TABLE "user_manga_state" ADD COLUMN "edited_at" DATETIME;
ALTER TABLE "user_manga_category" ADD COLUMN "edited_at" DATETIME;
