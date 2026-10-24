import { describe, expect, it, vi } from 'vitest';
import { decodeSourceRouteId } from '@/lib/source-route-id';
const details = vi.hoisted(() => vi.fn());
vi.mock('@projekt-manga/api-client', async (original) => ({
  ...(await original<typeof import('@projekt-manga/api-client')>()),
  getSourceMangaDetails: details,
}));
vi.mock('@/app/discover/preview/[sourceId]/[mangaId]/client', () => ({
  SourcePreviewClient: () => null,
}));
vi.mock('@/app/discover/preview/[sourceId]/[mangaId]/read/client', () => ({
  SourceReaderClient: () => null,
}));
import Preview, {
  generateMetadata as previewMetadata,
} from '@/app/discover/preview/[sourceId]/[mangaId]/page';
import Reader, {
  generateMetadata as readerMetadata,
} from '@/app/discover/preview/[sourceId]/[mangaId]/read/page';

describe('source preview route identifiers', () => {
  it.each([
    ['nkusp8ja47%2F1-mas-1', 'nkusp8ja47/1-mas-1'],
    ['%2Fmanga%2Ftitle%2F', '/manga/title/'],
    ['native%3Fquery%23fragment', 'native?query#fragment'],
    ['literal%252F', 'literal%2F'],
    ['100% and literal%20', '100% and literal%20'],
    ['タイトル', 'タイトル'],
    ['plain-title', 'plain-title'],
  ])('restores %s without repeatedly decoding the identifier', (input, native) => {
    expect(decodeSourceRouteId(input)).toBe(native);
  });
  it.each([Preview, Reader, previewMetadata, readerMetadata])(
    'passes the native compound identifier to the API in pages and metadata',
    async (renderPage) => {
      details
        .mockClear()
        .mockResolvedValue({ id: 'nkusp8ja47/1-mas-1', title: '1 más 1', description: '' });
      await renderPage({
        params: Promise.resolve({ sourceId: 'leercapitulo', mangaId: 'nkusp8ja47%2F1-mas-1' }),
      });
      expect(details).toHaveBeenCalledWith('leercapitulo', 'nkusp8ja47/1-mas-1');
    },
  );
});
