import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  markPreviousChaptersAsRead,
  markPreviousChaptersAsUnread,
} from '@projekt-manga/api-client';

const desktopWindow = window as unknown as {
  desktop?: {
    data: { invoke: ReturnType<typeof vi.fn> };
  };
};

afterEach(() => {
  delete desktopWindow.desktop;
});

describe('desktop bulk chapter progress', () => {
  it('updates local chapter state and history for a library manga', async () => {
    const invoke = vi.fn().mockResolvedValue({ success: true, message: '', data: null });
    desktopWindow.desktop = { data: { invoke } };

    const result = await markPreviousChaptersAsRead(
      'story',
      [{ id: 'chapter-1', chapter_number: 1, source: 'source-a', page_count: 12 }],
      { manga_id: 'manga-1', title: 'Story' },
    );

    expect(result).toEqual({ count: 1, failed_source_chapter_keys: [] });
    expect(invoke).toHaveBeenCalledWith('chapter', 'markRead', {
      isRead: true,
      chapter: {
        id: 'chapter-1',
        chapter_number: 1,
        source: 'source-a',
        page_count: 12,
        manga_id: 'manga-1',
        manga_slug: 'story',
        source_chapter_key: 'chapter-1',
      },
    });
    expect(invoke).toHaveBeenCalledWith(
      'history',
      'add',
      expect.objectContaining({
        manga_id: 'manga-1',
        source_chapter_key: 'chapter-1',
        pages_read: 12,
      }),
    );
  });

  it('reports partial failures instead of claiming every chapter changed', async () => {
    const invoke = vi
      .fn()
      .mockImplementation(
        async (domain: string, _op: string, args: { chapter?: { source_chapter_key?: string } }) =>
          domain === 'chapter' && args.chapter?.source_chapter_key === 'chapter-2'
            ? { success: false, message: 'write failed' }
            : { success: true, message: '', data: null },
      );
    desktopWindow.desktop = { data: { invoke } };

    const result = await markPreviousChaptersAsUnread('story', [
      { id: 'chapter-1', chapter_number: 1, source: 'source-a' },
      { id: 'chapter-2', chapter_number: 2, source: 'source-a' },
    ]);

    expect(result).toEqual({ count: 1, failed_source_chapter_keys: ['chapter-2'] });
  });
});
