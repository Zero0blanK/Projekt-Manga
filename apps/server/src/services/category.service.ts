import categoryRepository from '../repositories/category.repository.js';
import {
  MangaNotFoundError,
  ValidationError,
  DuplicateResourceError,
} from '../utils/customErrors.js';

const getCategory = async () => {
  return await categoryRepository.getCategory();
};

const getCategoryById = async (category_id: string) => {
  const category = await categoryRepository.getCategoryById(category_id);
  if (!category) {
    throw new MangaNotFoundError('Category not found');
  }
  return category;
};

const assertValidCategoryName = async (category_name: string) => {
  if (!category_name || category_name.trim() === '') {
    throw new ValidationError('Category name cannot be empty');
  }

  const existingCategories = await categoryRepository.getCategory();
  const duplicate = existingCategories.find(
    (cat) => cat.name.toLowerCase() === category_name.toLowerCase(),
  );
  if (duplicate) {
    throw new DuplicateResourceError('Category with the same name already exists');
  }
};

const addCategory = async (category_name: string) => {
  await assertValidCategoryName(category_name);
  return await categoryRepository.addCategory(category_name);
};

const updateCategory = async (category_id: string, category_name: string) => {
  await assertValidCategoryName(category_name);
  return await categoryRepository.updateCategory(category_id, category_name);
};

const deleteCategory = async (category_id: string) => {
  return await categoryRepository.deleteCategory(category_id);
};

const categoryService = {
  getCategory,
  getCategoryById,
  addCategory,
  updateCategory,
  deleteCategory,
};

export default categoryService;
