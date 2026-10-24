import { describe, expect, it } from 'vitest';
import { resolveSourceUrl, websiteUrl } from '@/lib/source-url';

describe('resolveSourceUrl', () => {
  it('keeps absolute source URLs', () => {
    expect(resolveSourceUrl('https://example.org/ch/1', 'https://other.example')).toBe(
      'https://example.org/ch/1',
    );
  });

  it('resolves site-relative paths against the source base URL', () => {
    expect(resolveSourceUrl('/manga/one/chapter-1', 'https://example.org')).toBe(
      'https://example.org/manga/one/chapter-1',
    );
  });

  it('returns null when there is nothing usable to resolve', () => {
    expect(resolveSourceUrl('', 'https://example.org')).toBeNull();
    expect(resolveSourceUrl(undefined, 'https://example.org')).toBeNull();
    expect(resolveSourceUrl('/relative', undefined)).toBeNull();
  });

  it('rejects non-http(s) schemes', () => {
    expect(resolveSourceUrl('javascript:alert(1)', 'https://example.org')).toBeNull();
  });
});

describe('websiteUrl', () => {
  it('accepts plain http(s) addresses', () => {
    expect(websiteUrl('https://example.org/a')).toBe('https://example.org/a');
    expect(websiteUrl('http://example.org')).toBe('http://example.org/');
  });

  it('rejects other schemes, credentials, and unparsable values', () => {
    for (const value of [
      'javascript:alert(1)',
      'data:text/html,hi',
      'ftp://example.org',
      'https://user:pass@example.org',
      '/relative',
      '',
      null,
      undefined,
    ]) {
      expect(websiteUrl(value)).toBeNull();
    }
  });
});
