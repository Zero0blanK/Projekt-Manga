import path from 'path';
import fs from 'fs';
import { fileURLToPath } from 'url';
import express from 'express';
import { load } from 'js-yaml';
import swaggerUi from 'swagger-ui-express';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// openapi.yaml sits at the package root: two levels above routes/ in src/ and dist/, and
// one level above the desktop installer's bundled dist/app.mjs (apps/desktop/scripts/
// bundle-server.mjs), where this module's URL is the bundle's.
const SPEC_PATH =
  [path.resolve(__dirname, '../../openapi.yaml'), path.resolve(__dirname, '../openapi.yaml')].find(
    (candidate) => fs.existsSync(candidate),
  ) ?? path.resolve(__dirname, '../../openapi.yaml');

function loadSpec(): Record<string, unknown> | null {
  try {
    const raw = fs.readFileSync(SPEC_PATH, 'utf8');
    return load(raw) as Record<string, unknown>;
  } catch (error) {
    console.error(`[docs] Failed to load ${SPEC_PATH}:`, error);
    return null;
  }
}

const router = express.Router();
const spec = loadSpec();

if (spec) {
  router.get('/openapi.json', (_req, res) => res.json(spec));
  router.use('/', swaggerUi.serve, swaggerUi.setup(spec));
} else {
  router.use((_req, res) => {
    res.status(503).json({
      success: false,
      message: 'API documentation is unavailable (failed to load openapi.yaml)',
    });
  });
}

export default router;
