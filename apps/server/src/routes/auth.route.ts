import express from 'express';
import rateLimit from 'express-rate-limit';
import authController from '../controllers/auth.controller.js';
import { validateBody } from '../middleware/validate.middleware.js';
import { requireAuth } from '../middleware/auth.middleware.js';
import {
  registerBodySchema,
  loginBodySchema,
  deleteAccountBodySchema,
  registerDeviceBodySchema,
} from '@projekt-manga/schemas';

const router = express.Router();

// Stops a script from hammering bcrypt or brute-forcing passwords through the
// password endpoints.
const authRateLimit = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: 20,
  standardHeaders: true,
  legacyHeaders: false,
  message: { success: false, message: 'Too many attempts — please wait and try again.' },
});

router.post('/register', authRateLimit, validateBody(registerBodySchema), authController.register);
router.post('/login', authRateLimit, validateBody(loginBodySchema), authController.login);
router.post('/logout', authController.logout);
router.get('/me', authController.me);
router.delete(
  '/me',
  requireAuth,
  authRateLimit,
  validateBody(deleteAccountBodySchema),
  authController.deleteAccount,
);
router.post(
  '/devices/register',
  requireAuth,
  validateBody(registerDeviceBodySchema),
  authController.registerDevice,
);
router.post('/sessions/revoke-others', requireAuth, authController.signOutOtherDevices);

export default router;
