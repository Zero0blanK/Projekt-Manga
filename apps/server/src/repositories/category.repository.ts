import prisma from '../configs/prisma.config.js';

const getCategory = async () => {
  return await prisma.category.findMany();
};

const getCategoryById = async (category_id: string) => {
  return await prisma.category.findUnique({
    where: {
      id: category_id,
    },
  });
};

/**
 * The stored id for a category name: lowercased, spaces to hyphens.
 *
 * This is the canonical form of a category, and `addCategory` derives the primary key
 * from it — so it is also the only case-insensitive handle the schema has.
 */
export const canonicalCategoryId = (category_name: string): string =>
  category_name.trim().toLowerCase().replace(/\s+/g, '-');

/**
 * Looks a category up by name, case-insensitively.
 *
 * Matches on the derived id rather than on `name`, and that is load-bearing rather than
 * incidental. SQLite's default collation is case-sensitive, so `where: { name }` would not
 * match an incoming "action" against a stored "Action". `addCategory` derives the id from
 * the same lowercased name, so the create that followed the missed lookup would collide on
 * the *primary key* and raise P2002, breaking the sync path (sync.service.ts resolves
 * categories by name so devices converge).
 *
 * `name` is left as the user first typed it, so display casing survives.
 */
const getCategoryByName = async (category_name: string) => {
  return await prisma.category.findUnique({
    where: {
      id: canonicalCategoryId(category_name),
    },
  });
};

/** Category names are a single shared vocabulary across every account (see the schema's
 * doc comment on user_manga_category) — sync resolves an incoming category by name
 * rather than trusting a client-supplied id, creating it if no device has ever pushed
 * that name before. */
const findOrCreateByName = async (category_name: string) => {
  const existing = await getCategoryByName(category_name);
  if (existing) {
    return existing;
  }
  return await addCategory(category_name);
};

const addCategory = async (category_name: string) => {
  return await prisma.category.create({
    data: {
      id: canonicalCategoryId(category_name),
      name: category_name.trim(),
    },
  });
};

const updateCategory = async (category_id: string, category_name: string) => {
  return await prisma.category.update({
    where: {
      id: category_id,
    },
    data: {
      id: category_name.toLowerCase().replace(/\s+/g, '-'),
      name: category_name,
    },
  });
};

/** Used only by auth.service's "first account claims existing anonymous data" — every
 * shared manga_category assignment. */
const getAllAssignments = async () => {
  return await prisma.manga_category.findMany({ select: { manga_id: true, category_id: true } });
};

const deleteCategory = async (category_id: string) => {
  return await prisma.category.delete({
    where: {
      id: category_id,
    },
  });
};

const categoryRepository = {
  getCategory,
  getCategoryById,
  getCategoryByName,
  findOrCreateByName,
  getAllAssignments,
  addCategory,
  updateCategory,
  deleteCategory,
};

export default categoryRepository;
