import { expect, it } from 'vitest';
import { coverFileName, coverFileProblem } from '@/lib/cover-file';

it('names a saved cover after its title, safely for any file system', () => {
  expect(coverFileName('Test Manga', 'image/webp')).toBe('Test Manga cover.webp');
  expect(coverFileName('Re:Zero / Part 2?', 'image/jpeg')).toBe('Re Zero Part 2 cover.jpg');
  expect(coverFileName('...hidden', 'image/png')).toBe('hidden cover.png');
  expect(coverFileName('///', 'application/octet-stream')).toBe('cover.jpg');
});

it('accepts only supported cover images of up to 5 MB', () => {
  expect(coverFileProblem(new File(['x'], 'a.png', { type: 'image/png' }))).toBeNull();
  expect(coverFileProblem(new File(['x'], 'a.svg', { type: 'image/svg+xml' }))).toMatch(/JPEG/);
  const large = new File([new Uint8Array(5 * 1024 * 1024 + 1)], 'a.png', { type: 'image/png' });
  expect(coverFileProblem(large)).toMatch(/5 MB/);
});
