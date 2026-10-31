import express from 'express';
import { updateSourceNetworkConfigBodySchema } from '@projekt-manga/schemas';
import { validateBody } from '../middleware/validate.middleware.js';
import { requireAdmin } from '../middleware/admin.middleware.js';
import {
  getSourceNetworkConfig,
  patchSourceNetworkConfig,
} from '../controllers/sourceNetwork.controller.js';

/** How sandboxed sources reach the network is a host-level setting, so it gets the same
 * admission as installing extension code. */
const router = express.Router();
router.use(requireAdmin);
router.get('/', getSourceNetworkConfig);
router.patch('/', validateBody(updateSourceNetworkConfigBodySchema), patchSourceNetworkConfig);
export default router;
