import express, { type NextFunction, type Request, type Response } from 'express';
import { translateBodySchema, type TranslateBody } from '@projekt-manga/schemas';
import { validateBody } from '../middleware/validate.middleware.js';
import { HTTPSuccessResponse } from '../utils/responseHandlers.js';
import translateService from '../services/translate.service.js';

/**
 * Reader › Translate page: Japanese text read on the device, translated by the host's
 * configured service. Rate limited per account, or per address for anonymous use.
 */
const router = express.Router();

router.get('/status', (_req: Request, res: Response) =>
  HTTPSuccessResponse(res, 200, 'OK', translateService.status()),
);

router.post(
  '/',
  validateBody(translateBodySchema),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const identity = req.user?.id ?? `ip:${req.ip ?? 'unknown'}`;
      const result = await translateService.translate(req.validated as TranslateBody, identity);
      return HTTPSuccessResponse(res, 200, 'OK', result);
    } catch (error) {
      return next(error);
    }
  },
);

export default router;
