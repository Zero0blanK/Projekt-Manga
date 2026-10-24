import prisma from '../configs/prisma.config.js';

const getAllRepositories = async () => {
  return await prisma.extension_repository.findMany({ orderBy: { added_at: 'asc' } });
};

const getRepositoryById = async (id: string) => {
  return await prisma.extension_repository.findUnique({ where: { id } });
};

const getRepositoryByUrl = async (url: string) => {
  return await prisma.extension_repository.findUnique({ where: { url } });
};

/** What a repository publishes about itself. Null for anything it doesn't. */
export interface RepositoryMetadataInput {
  name: string | null;
  badge_label: string | null;
  description: string | null;
  website: string | null;
}

const createRepository = async (url: string, metadata: RepositoryMetadataInput) => {
  return await prisma.extension_repository.create({
    data: { url, ...metadata, last_fetched_at: new Date() },
  });
};

/**
 * Marks a repository as just fetched, optionally refreshing what it says about itself.
 *
 * Each field is written only when the listing actually carries it: a repository that
 * stops publishing its name should not have a good stored one blanked out by the next
 * routine refresh.
 */
const touchRepositoryFetchedAt = async (id: string, metadata?: RepositoryMetadataInput) => {
  return await prisma.extension_repository.update({
    where: { id },
    data: {
      last_fetched_at: new Date(),
      ...(metadata?.name ? { name: metadata.name } : {}),
      ...(metadata?.badge_label ? { badge_label: metadata.badge_label } : {}),
      ...(metadata?.description ? { description: metadata.description } : {}),
      ...(metadata?.website ? { website: metadata.website } : {}),
    },
  });
};

const deleteRepository = async (id: string) => {
  return await prisma.extension_repository.delete({ where: { id } });
};

const getInstalledExtensions = async () => {
  return await prisma.installed_extension.findMany({ orderBy: { installed_at: 'asc' } });
};

const getInstalledExtensionsForRepository = async (repository_id: string) => {
  return await prisma.installed_extension.findMany({ where: { repository_id } });
};

const getInstalledExtensionById = async (id: string) => {
  return await prisma.installed_extension.findUnique({ where: { id } });
};

const getInstalledExtensionByKey = async (repository_id: string, source_key: string) => {
  return await prisma.installed_extension.findUnique({
    where: { repository_id_source_key: { repository_id, source_key } },
  });
};

/** Listing fields that describe the installed version but that a repository may omit. */
export interface InstalledExtensionMetadata {
  api_version: number;
  content_rating: string | null;
  version_code: number | null;
  description: string | null;
  homepage: string | null;
  icon_url: string | null;
}

const createInstalledExtension = async (
  data: {
    repository_id: string;
    source_key: string;
    name: string;
    lang: string;
    base_url: string;
    is_nsfw: boolean;
    allowed_hosts: string[];
    version: string;
    api_version: number;
    entry_url: string;
    source_code_hash: string;
  } & InstalledExtensionMetadata,
) => {
  return await prisma.installed_extension.create({ data });
};

const updateInstalledExtension = async (
  id: string,
  data: {
    lang: string;
    base_url: string;
    is_nsfw: boolean;
    allowed_hosts: string[];
    version: string;
    api_version: number;
    entry_url: string;
    source_code_hash: string;
  } & InstalledExtensionMetadata,
) => {
  return await prisma.installed_extension.update({ where: { id }, data });
};

const deleteInstalledExtension = async (id: string) => {
  return await prisma.installed_extension.delete({ where: { id } });
};

const extensionRepositoryRepository = {
  getAllRepositories,
  getRepositoryById,
  getRepositoryByUrl,
  createRepository,
  touchRepositoryFetchedAt,
  deleteRepository,
  getInstalledExtensions,
  getInstalledExtensionsForRepository,
  getInstalledExtensionById,
  getInstalledExtensionByKey,
  createInstalledExtension,
  updateInstalledExtension,
  deleteInstalledExtension,
};

export default extensionRepositoryRepository;
