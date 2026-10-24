import { Request, Response, NextFunction } from 'express';
import { HTTPSuccessResponse } from '../utils/responseHandlers.js';
import categoryService from '../services/category.service.js';
import type { CategoryNameBody } from '@projekt-manga/schemas';

const getCategory = async (req: Request, res: Response, next: NextFunction) => {
  try {
    const categories = await categoryService.getCategory();
    return HTTPSuccessResponse(res, 200, 'Categories retrieved successfully', categories);
  } catch (error) {
    return next(error);
  }
};

const getCategoryById = async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { category_id } = req.params as { category_id: string };

    const category = await categoryService.getCategoryById(category_id);
    return HTTPSuccessResponse(res, 200, 'Category retrieved successfully', category);
  } catch (error) {
    return next(error);
  }
};

const addCategory = async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { category_name } = req.validated as CategoryNameBody;

    const newCategory = await categoryService.addCategory(category_name);
    return HTTPSuccessResponse(res, 201, 'Category added successfully', newCategory);
  } catch (error) {
    return next(error);
  }
};

const updateCategory = async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { category_id } = req.params as { category_id: string };
    const { category_name } = req.validated as CategoryNameBody;

    const updatedCategory = await categoryService.updateCategory(category_id, category_name);
    return HTTPSuccessResponse(res, 200, 'Category updated successfully', updatedCategory);
  } catch (error) {
    return next(error);
  }
};

const deleteCategory = async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { category_id } = req.params as { category_id: string };

    await categoryService.deleteCategory(category_id);
    return HTTPSuccessResponse(res, 200, 'Category deleted successfully');
  } catch (error) {
    return next(error);
  }
};

const categoryController = {
  getCategory,
  getCategoryById,
  addCategory,
  updateCategory,
  deleteCategory,
};

export default categoryController;
