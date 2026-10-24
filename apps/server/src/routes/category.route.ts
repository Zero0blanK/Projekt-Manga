import express from 'express';
import categoryController from '../controllers/category.controller.js';
import { validateBody } from '../middleware/validate.middleware.js';
import { categoryNameBodySchema } from '@projekt-manga/schemas';

const router = express.Router();

router.get('/', categoryController.getCategory);
router.get('/:category_id', categoryController.getCategoryById);
router.post('/add', validateBody(categoryNameBodySchema), categoryController.addCategory);
router.put(
  '/update/:category_id',
  validateBody(categoryNameBodySchema),
  categoryController.updateCategory,
);
router.delete('/delete/:category_id', categoryController.deleteCategory);

export default router;
