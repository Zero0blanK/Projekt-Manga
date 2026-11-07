import express from 'express';
import categoryController from '../controllers/category.controller.js';
import { validateBody } from '../middleware/validate.middleware.js';
import { categoryImportBodySchema, categoryNameBodySchema } from '@projekt-manga/schemas';

const router = express.Router();

router.get('/', categoryController.getCategory);
// Fixed paths, ordered before `/:category_id` so "state" is never read as an id.
router.get('/state', categoryController.getCategoryState);
router.post('/import', validateBody(categoryImportBodySchema), categoryController.importCategories);
router.get('/:category_id', categoryController.getCategoryById);
router.post('/add', validateBody(categoryNameBodySchema), categoryController.addCategory);
router.put(
  '/update/:category_id',
  validateBody(categoryNameBodySchema),
  categoryController.updateCategory,
);
router.delete('/delete/:category_id', categoryController.deleteCategory);
router.put('/:category_id/manga/:manga_id', categoryController.setMembership);
router.delete('/:category_id/manga/:manga_id', categoryController.setMembership);

export default router;
