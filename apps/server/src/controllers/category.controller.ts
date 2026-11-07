import { Request, Response, NextFunction } from 'express';
import { HTTPSuccessResponse } from '../utils/responseHandlers.js';
import categoryService from '../services/category.service.js';
import type { CategoryImportBody, CategoryNameBody } from '@projekt-manga/schemas';

/** Whose list a request acts on: the signed-in account's, or the anonymous one. */
const ownerOf = (req: Request) => req.user?.id ?? null;

const getCategory = async (req: Request, res: Response, next: NextFunction) => {
  try {
    const categories = await categoryService.getCategory(ownerOf(req));
    return HTTPSuccessResponse(res, 200, 'Categories retrieved successfully', categories);
  } catch (error) {
    return next(error);
  }
};

const getCategoryById = async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { category_id } = req.params as { category_id: string };

    const category = await categoryService.getCategoryById(category_id, ownerOf(req));
    return HTTPSuccessResponse(res, 200, 'Category retrieved successfully', category);
  } catch (error) {
    return next(error);
  }
};

const addCategory = async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { category_name } = req.validated as CategoryNameBody;

    const newCategory = await categoryService.addCategory(category_name, ownerOf(req));
    return HTTPSuccessResponse(res, 201, 'Category added successfully', newCategory);
  } catch (error) {
    return next(error);
  }
};

const updateCategory = async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { category_id } = req.params as { category_id: string };
    const { category_name } = req.validated as CategoryNameBody;

    const updatedCategory = await categoryService.updateCategory(
      category_id,
      category_name,
      ownerOf(req),
    );
    return HTTPSuccessResponse(res, 200, 'Category updated successfully', updatedCategory);
  } catch (error) {
    return next(error);
  }
};

const deleteCategory = async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { category_id } = req.params as { category_id: string };

    await categoryService.deleteCategory(category_id, ownerOf(req));
    return HTTPSuccessResponse(res, 200, 'Category deleted successfully');
  } catch (error) {
    return next(error);
  }
};

const getCategoryState = async (req: Request, res: Response, next: NextFunction) => {
  try {
    const state = await categoryService.getCategoryState(ownerOf(req));
    return HTTPSuccessResponse(res, 200, 'Categories retrieved successfully', state);
  } catch (error) {
    return next(error);
  }
};

const setMembership = async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { category_id, manga_id } = req.params as { category_id: string; manga_id: string };
    await categoryService.setMembership(category_id, manga_id, req.method === 'PUT', ownerOf(req));
    return HTTPSuccessResponse(res, 200, 'Category updated successfully');
  } catch (error) {
    return next(error);
  }
};

const importCategories = async (req: Request, res: Response, next: NextFunction) => {
  try {
    const summary = await categoryService.importCategories(
      req.validated as CategoryImportBody,
      ownerOf(req),
    );
    return HTTPSuccessResponse(res, 200, 'Categories imported successfully', summary);
  } catch (error) {
    return next(error);
  }
};

const categoryController = {
  getCategory,
  getCategoryState,
  setMembership,
  importCategories,
  getCategoryById,
  addCategory,
  updateCategory,
  deleteCategory,
};

export default categoryController;
