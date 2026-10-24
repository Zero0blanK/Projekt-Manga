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

    expect(result).toEqual({ count: 1, failed_chapter_ids: [] });
    expect(invoke).toHaveBeenCalledWith('chapter', 'markRead', {
      chapterId: 'chapter-1',
      isRead: true,
      chapter: {
        id: 'chapter-1',
        chapter_number: 1,
        source: 'source-a',
        page_count: 12,
        manga_id: 'manga-1',
      },
    });
    expect(invoke).toHaveBeenCalledWith(
      'history',
      'add',
      expect.objectContaining({ manga_id: 'manga-1', chapter_id: 'chapter-1', pages_read: 12 }),
    );
  });

  it('reports partial failures instead of claiming every chapter changed', async () => {
    const invoke = vi
      .fn()
      .mockImplementation(async (domain: string, _op: string, args: { chapterId?: string }) =>
        domain === 'chapter' && args.chapterId === 'chapter-2'
          ? { success: false, message: 'write failed' }
          : { success: true, message: '', data: null },
      );
    desktopWindow.desktop = { data: { invoke } };

    const result = await markPreviousChaptersAsUnread('story', [
      { id: 'chapter-1', chapter_number: 1 },
      { id: 'chapter-2', chapter_number: 2 },
    ]);

    expect(result).toEqual({ count: 1, failed_chapter_ids: ['chapter-2'] });
  });
});
