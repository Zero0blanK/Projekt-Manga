import prisma from '../configs/prisma.config.js';

/** Whose list a category belongs to: an account's id, or null for anonymous use. */
export type CategoryOwner = string | null;

/**
 * A category name in canonical form: lowercased, spaces to hyphens.
 *
 * Stored as `key`, the only case-insensitive handle the schema has. SQLite's default
 * collation is case-sensitive, so matching on `name` would miss an incoming "action"
 * against a stored "Action", and the create that followed would collide on the unique
 * key and break sync, which resolves categories by name so devices converge.
 */
export const canonicalCategoryKey = (category_name: string): string =>
  category_name.trim().toLowerCase().replace(/\s+/g, '-');

const getCategory = async (owner: CategoryOwner) => {
  return await prisma.category.findMany({
    where: { user_id: owner },
    orderBy: { created_at: 'asc' },
  });
};

/** Scoped to the owner, so another account's id reads as not found. */
const getCategoryById = async (category_id: string, owner: CategoryOwner) => {
  return await prisma.category.findFirst({ where: { id: category_id, user_id: owner } });
};

/** `name` keeps the casing the user first typed. */
const getCategoryByName = async (category_name: string, owner: CategoryOwner) => {
  return await prisma.category.findFirst({
    where: { user_id: owner, key: canonicalCategoryKey(category_name) },
  });
};

const addCategory = async (category_name: string, owner: CategoryOwner) => {
  return await prisma.category.create({
    data: {
      user_id: owner,
      key: canonicalCategoryKey(category_name),
      name: category_name.trim(),
    },
  });
};

/** Sync resolves an incoming category by name rather than trusting a client-supplied id,
 * creating it if this account's devices have never pushed that name before. */
const findOrCreateByName = async (category_name: string, owner: CategoryOwner) => {
  return (
    (await getCategoryByName(category_name, owner)) ?? (await addCategory(category_name, owner))
  );
};

/** The id stays put, so assignments and other devices' references survive a rename. */
const updateCategory = async (category_id: string, category_name: string) => {
  return await prisma.category.update({
    where: { id: category_id },
    data: { key: canonicalCategoryKey(category_name), name: category_name.trim() },
  });
};

const deleteCategory = async (category_id: string) => {
  return await prisma.category.delete({ where: { id: category_id } });
};

/** The anonymous list with its assignments, for "first account claims existing anonymous
 * data", which copies them into the account's own list. */
const getAnonymousCategoriesWithAssignments = async () => {
  return await prisma.category.findMany({
    where: { user_id: null },
    select: { name: true, manga_category: { select: { manga_id: true } } },
  });
};

const getAnonymousAssignments = async () => {
  return await prisma.manga_category.findMany({
    where: { category: { user_id: null } },
    select: { manga_id: true, category_id: true },
  });
};

const assignAnonymous = async (manga_id: string, category_id: string) => {
  return await prisma.manga_category.upsert({
    where: { manga_id_category_id: { manga_id, category_id } },
    create: { manga_id, category_id },
    update: {},
  });
};

const unassignAnonymous = async (manga_id: string, category_id: string) => {
  await prisma.manga_category.deleteMany({ where: { manga_id, category_id } });
};

const categoryRepository = {
  getCategory,
  getCategoryById,
  getCategoryByName,
  findOrCreateByName,
  getAnonymousCategoriesWithAssignments,
  getAnonymousAssignments,
  assignAnonymous,
  unassignAnonymous,
  addCategory,
  updateCategory,
  deleteCategory,
};

export default categoryRepository;
