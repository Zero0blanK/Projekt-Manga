import categoryRepository, { type CategoryOwner } from '../repositories/category.repository.js';
import userMangaCategoryRepository from '../repositories/userMangaCategory.repository.js';
import mangaRepository from '../repositories/manga.repository.js';
import { NotFoundError, DuplicateResourceError } from '../utils/customErrors.js';
import type { CategoryImportBody } from '@projekt-manga/schemas';

const getCategory = async (owner: CategoryOwner) => {
  return await categoryRepository.getCategory(owner);
};

/** Another account's category reads as missing, so ids can't be probed. */
const getCategoryById = async (category_id: string, owner: CategoryOwner) => {
  const category = await categoryRepository.getCategoryById(category_id, owner);
  if (!category) {
    throw new NotFoundError('Category not found');
  }
  return category;
};

const assertNameAvailable = async (
  category_name: string,
  owner: CategoryOwner,
  renaming?: string,
) => {
  const existing = await categoryRepository.getCategoryByName(category_name, owner);
  // A rename that only changes the case keeps the same key, and collides with itself.
  if (existing && existing.id !== renaming) {
    throw new DuplicateResourceError('Category with the same name already exists');
  }
};

const addCategory = async (category_name: string, owner: CategoryOwner) => {
  await assertNameAvailable(category_name, owner);
  return await categoryRepository.addCategory(category_name, owner);
};

const updateCategory = async (category_id: string, category_name: string, owner: CategoryOwner) => {
  await getCategoryById(category_id, owner);
  await assertNameAvailable(category_name, owner, category_id);
  return await categoryRepository.updateCategory(category_id, category_name);
};

const deleteCategory = async (category_id: string, owner: CategoryOwner) => {
  await getCategoryById(category_id, owner);
  return await categoryRepository.deleteCategory(category_id);
};

/** Every category the caller owns, with the titles in each: all the library needs. */
const getCategoryState = async (owner: CategoryOwner) => {
  const [categories, assignments] = await Promise.all([
    categoryRepository.getCategory(owner),
    owner
      ? userMangaCategoryRepository.getForUser(owner)
      : categoryRepository.getAnonymousAssignments(),
  ]);
  const membersByCategory = new Map<string, string[]>();
  for (const { category_id, manga_id } of assignments) {
    const members = membersByCategory.get(category_id);
    if (members) members.push(manga_id);
    else membersByCategory.set(category_id, [manga_id]);
  }
  return categories.map((category) => ({
    id: category.id,
    name: category.name,
    manga_ids: membersByCategory.get(category.id) ?? [],
  }));
};

const setMembership = async (
  category_id: string,
  manga_id: string,
  member: boolean,
  owner: CategoryOwner,
) => {
  await getCategoryById(category_id, owner);
  if (member && !(await mangaRepository.getMangaById(manga_id))) {
    throw new NotFoundError('Manga not found');
  }
  if (owner) {
    await (member
      ? userMangaCategoryRepository.assign(owner, manga_id, category_id)
      : userMangaCategoryRepository.unassign(owner, manga_id, category_id));
  } else {
    await (member
      ? categoryRepository.assignAnonymous(manga_id, category_id)
      : categoryRepository.unassignAnonymous(manga_id, category_id));
  }
};

/** Adds categories a device or backup held locally. Additive by design: an existing name
 * is reused and titles this server doesn't know are skipped, so a repeat is harmless. */
const importCategories = async (body: CategoryImportBody, owner: CategoryOwner) => {
  const known = await mangaRepository.filterExistingIds([
    ...new Set(body.categories.flatMap((category) => category.manga_ids)),
  ]);
  let imported = 0;
  for (const { name, manga_ids } of body.categories) {
    const category = await categoryRepository.findOrCreateByName(name, owner);
    for (const manga_id of manga_ids) {
      if (!known.has(manga_id)) continue;
      await setMembership(category.id, manga_id, true, owner);
      imported++;
    }
  }
  return { categories: body.categories.length, assignments: imported };
};

const categoryService = {
  getCategory,
  getCategoryById,
  getCategoryState,
  addCategory,
  updateCategory,
  deleteCategory,
  setMembership,
  importCategories,
};

export default categoryService;
