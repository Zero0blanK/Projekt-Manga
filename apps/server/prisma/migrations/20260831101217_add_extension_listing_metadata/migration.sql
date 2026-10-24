-- AlterTable
ALTER TABLE "extension_repositories" ADD COLUMN "badge_label" TEXT;
ALTER TABLE "extension_repositories" ADD COLUMN "description" TEXT;
ALTER TABLE "extension_repositories" ADD COLUMN "website" TEXT;

-- AlterTable
ALTER TABLE "installed_extensions" ADD COLUMN "content_rating" TEXT;
ALTER TABLE "installed_extensions" ADD COLUMN "description" TEXT;
ALTER TABLE "installed_extensions" ADD COLUMN "homepage" TEXT;
ALTER TABLE "installed_extensions" ADD COLUMN "icon_url" TEXT;
ALTER TABLE "installed_extensions" ADD COLUMN "version_code" INTEGER;
