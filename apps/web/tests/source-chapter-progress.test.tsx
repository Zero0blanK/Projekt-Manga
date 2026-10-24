import { describe, expect, it, vi } from 'vitest';
import { act, render, screen } from '@testing-library/react';
import { SourceChapterList } from '@/components/manga-detail/source-chapter-list';
import type { Chapters } from '@projekt-manga/types';
import type { HistoryEntry } from '@projekt-manga/api-client';
vi.mock('@/lib/session-resource', () => ({
  useCurrentUser: () => ({ user: null, loading: false }),
}));
vi.mock('@projekt-manga/api-client', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@projekt-manga/api-client')>()),
  getAllDownloads: vi.fn().mockResolvedValue([]),
}));

describe('source-only chapter progress', () => {
  it('shows saved page progress without a library manga', async () => {
    const chapter = {
      id: 'chapter-7',
      chapter_number: 7,
      name: 'Chapter Seven',
      url: 'https://example.com/chapter-7',
      page_count: 10,
    } as Chapters;
    const progress = {
      chapter_id: chapter.id,
      last_page_read: 3,
      page_count: 10,
      is_read: false,
    } as HistoryEntry;

    await act(async () => {
      render(
        <SourceChapterList
          chapters={[chapter]}
          mangaSlug="source-title"
          sourceMangaId="source-native-id"
          sourceId="source-a"
          mangaTitle="Source Title"
          readChapterIds={new Set()}
          chapterProgress={new Map([[chapter.id, progress]])}
          readerHref={(number) => `/discover/preview/source-a/source-native-id/read?ch=${number}`}
          onDownload={async () => undefined}
        />,
      );
    });

    expect(screen.getByText('3 / 10')).toBeInTheDocument();
    expect(screen.getByRole('link', { name: /Chapter Seven/ })).toHaveAttribute(
      'href',
      '/discover/preview/source-a/source-native-id/read?ch=7&chapterId=chapter-7',
    );
  });
});
