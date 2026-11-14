import express, { type NextFunction, type Request, type Response } from 'express';
import {
  translateBodySchema,
  translateReadBodySchema,
  translateSettingsBodySchema,
  type TranslateBody,
  type TranslateReadBody,
  type TranslateSettingsBody,
} from '@projekt-manga/schemas';
import { validateBody } from '../middleware/validate.middleware.js';
import { requireAdmin } from '../middleware/admin.middleware.js';
import { HTTPSuccessResponse } from '../utils/responseHandlers.js';
import translateService, { checkReadRate } from '../services/translate.service.js';
import localTranslation, { decodeImages } from '../services/localTranslation.service.js';
import translationSettings from '../services/translationSetting.service.js';

/**
 * Reader › Translate page: Japanese text read on the device, translated by the reader's own
 * service or else the host's. Rate limited per account, or per address for anonymous use.
 *
 * Settings › Reader › Page translation saves that service per identity. Changing the
 * anonymous library's gets the host admin check, as alert channels do: it sends text and a
 * key to an address of the saver's choosing. An account's own needs only that account.
 */
const router = express.Router();

const owner = (req: Request) => req.user?.id ?? null;
const anonymousNeedsAdmin = (req: Request, res: Response, next: NextFunction) =>
  req.user ? next() : requireAdmin(req, res, next);
const run =
  (work: (req: Request) => Promise<unknown>) =>
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      res.setHeader('Cache-Control', 'no-store');
      return HTTPSuccessResponse(res, 200, 'OK', await work(req));
    } catch (error) {
      return next(error);
    }
  };

router.get(
  '/status',
  run((req) => translateService.status(owner(req))),
);

router.get(
  '/settings',
  run((req) => translationSettings.get(owner(req))),
);
router.put(
  '/settings',
  anonymousNeedsAdmin,
  validateBody(translateSettingsBodySchema),
  run((req) => translationSettings.save(req.validated as TranslateSettingsBody, owner(req))),
);
router.delete(
  '/settings',
  anonymousNeedsAdmin,
  run(async (req) => {
    await translationSettings.remove(owner(req));
    return null;
  }),
);

/** Local translation's models: whether they are here, and their download. */
router.get(
  '/local',
  run(() => localTranslation.status()),
);
router.post(
  '/local/download',
  run(() => localTranslation.download()),
);

/** The Japanese in one page's speech bubbles, read by this server's manga-ocr. */
router.post(
  '/read',
  validateBody(translateReadBodySchema),
  run(async (req) => {
    const identity = req.user?.id ?? `ip:${req.ip ?? 'unknown'}`;
    checkReadRate(identity);
    const { images } = req.validated as TranslateReadBody;
    return { texts: await localTranslation.read(decodeImages(images)) };
  }),
);

router.post(
  '/',
  validateBody(translateBodySchema),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const identity = req.user?.id ?? `ip:${req.ip ?? 'unknown'}`;
      const result = await translateService.translate(
        req.validated as TranslateBody,
        identity,
        owner(req),
      );
      return HTTPSuccessResponse(res, 200, 'OK', result);
    } catch (error) {
      return next(error);
    }
  },
);

export default router;
