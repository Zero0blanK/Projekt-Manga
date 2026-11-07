import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import yaml from 'js-yaml';

/**
 * Every route the server mounts has to appear in openapi.yaml, and the other way round.
 *
 * Read from the route files rather than the running app: Express 5 doesn't keep a mounted
 * router's path anywhere it can be read back. This checks that a route is documented, not
 * that its documented shape is right.
 */

const ROOT = path.join(__dirname, '..');
const METHODS = ['get', 'post', 'put', 'patch', 'delete'];

function routesInCode(): string[] {
  const app = fs.readFileSync(path.join(ROOT, 'src/app.ts'), 'utf8');
  const files = new Map(
    [...app.matchAll(/import (\w+)(?:, \{[^}]*\})? from '\.\/routes\/([\w.-]+)\.js'/g)].map(
      (match) => [match[1], match[2]],
    ),
  );
  const routes: string[] = [];
  for (const [, base, name] of app.matchAll(/app\.use\('(\/api\/[^']+)', (\w+)\)/g)) {
    const file = files.get(name);
    if (!file || file === 'docs.route') continue;
    const source = fs.readFileSync(path.join(ROOT, 'src/routes', `${file}.ts`), 'utf8');
    for (const [, method, route] of source.matchAll(
      /router\.(get|post|put|patch|delete)\(\s*'([^']*)'/g,
    )) {
      const documented = `${base}${route}`
        .replace(/^\/api/, '')
        .replace(/\/$/, '')
        .replace(/:(\w+)/g, '{$1}');
      routes.push(`${method.toUpperCase()} ${documented}`);
    }
  }
  return [...new Set(routes)].sort();
}

function routesInSpec(): string[] {
  const spec = yaml.load(fs.readFileSync(path.join(ROOT, 'openapi.yaml'), 'utf8')) as {
    paths: Record<string, Record<string, unknown>>;
  };
  return Object.entries(spec.paths)
    .flatMap(([route, operations]) =>
      Object.keys(operations)
        .filter((key) => METHODS.includes(key))
        .map((method) => `${method.toUpperCase()} ${route}`),
    )
    .sort();
}

describe('openapi.yaml', () => {
  it('documents every route', () => {
    const documented = new Set(routesInSpec());

    expect(routesInCode().filter((route) => !documented.has(route))).toEqual([]);
  });

  it('documents no route that no longer exists', () => {
    const real = new Set(routesInCode());

    expect(routesInSpec().filter((route) => !real.has(route))).toEqual([]);
  });
});
