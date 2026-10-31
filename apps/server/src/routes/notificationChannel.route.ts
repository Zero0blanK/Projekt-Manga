import express, { type NextFunction, type Request, type Response } from 'express';
import {
  chapterAlertBodySchema,
  createNotificationChannelBodySchema,
  updateNotificationChannelBodySchema,
  type ChapterAlertBody,
  type CreateNotificationChannelBody,
  type UpdateNotificationChannelBody,
} from '@projekt-manga/schemas';
import { validateBody } from '../middleware/validate.middleware.js';
import { requireAdmin } from '../middleware/admin.middleware.js';
import { HTTPSuccessResponse } from '../utils/responseHandlers.js';
import notificationChannelService from '../services/notificationChannel.service.js';

/**
 * Alert channels (Settings › Notifications › Outside the app), per identity. Changing the
 * anonymous library's channels gets the host admin check: they send to addresses of the
 * owner's choosing, so a passer-by on the network shouldn't set them. An account's own
 * channels need only that account.
 */
const router = express.Router();

const owner = (req: Request) => req.user?.id ?? null;
const anonymousNeedsAdmin = (req: Request, res: Response, next: NextFunction) =>
  req.user ? next() : requireAdmin(req, res, next);
const run =
  (work: (req: Request) => Promise<unknown>, status = 200, message = 'OK') =>
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      return HTTPSuccessResponse(res, status, message, await work(req));
    } catch (error) {
      return next(error);
    }
  };

router.get(
  '/',
  run((req) => notificationChannelService.list(owner(req))),
);
router.post(
  '/',
  anonymousNeedsAdmin,
  validateBody(createNotificationChannelBodySchema),
  run(
    (req) =>
      notificationChannelService.create(req.validated as CreateNotificationChannelBody, owner(req)),
    201,
    'Alert channel added',
  ),
);
// What a library update found, sent once at the end of the run.
router.post(
  '/alert',
  validateBody(chapterAlertBodySchema),
  run((req) => notificationChannelService.alert(req.validated as ChapterAlertBody, owner(req))),
);
router.patch(
  '/:channel_id',
  anonymousNeedsAdmin,
  validateBody(updateNotificationChannelBodySchema),
  run((req) =>
    notificationChannelService.update(
      req.params.channel_id as string,
      req.validated as UpdateNotificationChannelBody,
      owner(req),
    ),
  ),
);
router.delete(
  '/:channel_id',
  anonymousNeedsAdmin,
  run((req) => notificationChannelService.remove(req.params.channel_id as string, owner(req))),
);
router.post(
  '/:channel_id/test',
  anonymousNeedsAdmin,
  run((req) => notificationChannelService.test(req.params.channel_id as string, owner(req))),
);

export default router;
