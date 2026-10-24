import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { RELEASES, CURRENT_RELEASE } from '@/lib/changelog';

/**
 * The changelog is not just prose: its newest entry is what the About panel reports as the
 * app's version. The *actual* version is `apps/desktop/package.json`, which is what
 * `app.getVersion()` returns and what the updater compares against a GitHub release.
 *
 * If the two disagree, Settings > About shows contradictory versions, and the changelog
 * can describe a release the updater (which compares against the real version) could
 * never offer.
 */
describe('changelog', () => {
  it('reports the same version the app actually runs as', () => {
    const packageJsonPath = path.resolve(__dirname, '../../desktop/package.json');
    const { version } = JSON.parse(readFileSync(packageJsonPath, 'utf-8')) as { version: string };

    expect(CURRENT_RELEASE.version).toBe(version);
  });

  it('is ordered newest-first, which is what CURRENT_RELEASE assumes', () => {
    const toParts = (v: string) => v.split('.').map(Number);
    for (let i = 0; i < RELEASES.length - 1; i++) {
      const [aMaj, aMin, aPatch] = toParts(RELEASES[i].version);
      const [bMaj, bMin, bPatch] = toParts(RELEASES[i + 1].version);
      const newer =
        aMaj > bMaj || (aMaj === bMaj && (aMin > bMin || (aMin === bMin && aPatch > bPatch)));
      expect(newer, `${RELEASES[i].version} should sort above ${RELEASES[i + 1].version}`).toBe(
        true,
      );
    }
  });

  it('gives every release a date and at least one change', () => {
    for (const release of RELEASES) {
      expect(release.date, `${release.version} has no date`).toMatch(/^\d{4}-\d{2}-\d{2}$/);
      expect(release.changes.length, `${release.version} lists no changes`).toBeGreaterThan(0);
    }
  });
});
