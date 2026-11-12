import { describe, it, expect } from 'vitest';
import { installedExtensionFor, installedExtensionsByKey } from '@projekt-manga/types';

const row = (id: string, source_key: string, enabled: boolean) => ({ id, source_key, enabled });

describe('the installed extension behind a source id', () => {
  it('is the first-installed enabled row, as the server loads it', () => {
    const rows = [row('a', 'mangadex', true), row('b', 'mangadex', true)];
    expect(installedExtensionFor(rows, 'mangadex')?.id).toBe('a');
    expect(installedExtensionsByKey(rows).get('mangadex')?.id).toBe('a');
  });

  it('skips a disabled row when an enabled one carries the key', () => {
    const rows = [row('a', 'mangadex', false), row('b', 'mangadex', true)];
    expect(installedExtensionFor(rows, 'mangadex')?.id).toBe('b');
    expect(installedExtensionsByKey(rows).get('mangadex')?.id).toBe('b');
  });

  it('still describes a source whose only row is disabled', () => {
    const rows = [row('a', 'mangadex', false), row('b', 'mangadex', false)];
    expect(installedExtensionFor(rows, 'mangadex')?.id).toBe('a');
    expect(installedExtensionsByKey(rows).get('mangadex')?.id).toBe('a');
  });

  it('matches the key exactly and answers undefined for none', () => {
    const rows = [row('a', 'mangadex', true)];
    expect(installedExtensionFor(rows, 'MangaDex')).toBeUndefined();
    expect(installedExtensionFor(rows, 'mangadex-es')).toBeUndefined();
  });
});
