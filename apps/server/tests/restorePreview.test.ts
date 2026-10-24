import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { PreviewBackupBody } from '@projekt-manga/schemas';

const prismaMock = vi.hoisted(() => ({
  manga: { findMany: vi.fn() },
  user_library: { findMany: vi.fn() },
  manga_detail: { findMany: vi.fn() },
  chapter: { findMany: vi.fn() },
  history: { findMany: vi.fn() },
}));

vi.mock('../src/configs/prisma.config.js', () => ({ default: prismaMock }));

import { previewBackupConflicts } from '../src/repositories/restore.repository.js';

describe('restore catalog preview', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    prismaMock.manga.findMany.mockResolvedValue([
      {
        id: 'existing-manga',
        source: 'fixture',
        slug: 'existing',
        in_library: false,
        title: 'Old title',
        author: 'Author',
        thumbnail_url: 'cover',
      },
    ]);
    prismaMock.user_library.findMany.mockResolvedValue([]);
    prismaMock.manga_detail.findMany.mockResolvedValue([
      {
        manga_id: 'existing-manga',
        artist: 'Unknown',
        description: '',
        genres: '',
        status: 'UNKNOWN',
        rating: null,
      },
    ]);
    prismaMock.chapter.findMany.mockResolvedValue([
      { id: 'collision', manga: { source: 'fixture', slug: 'different' } },
    ]);
    prismaMock.history.findMany.mockResolvedValue([
      { source: 'fixture', manga_slug: 'existing', chapter_id: 'history-1' },
    ]);
  });

  it('reports current catalog differences and chapter ID collisions without writes', async () => {
    const backup = {
      expectedUserId: null,
      mode: 'merge',
      version: 2,
      manga: [
        {
          id: 'import-existing',
          source: 'fixture',
          slug: 'existing',
          title: 'New title',
          author: 'Author',
          thumbnail_url: 'cover',
          artist: null,
          description: '',
          genres: '',
          status: 'UNKNOWN',
          rating: null,
          chapters: [{ id: 'collision', chapter_number: 2 }],
        },
        {
          id: 'import-new',
          source: 'fixture',
          slug: 'new',
          title: 'New manga',
          author: 'Author',
          thumbnail_url: 'cover',
          artist: null,
          description: '',
          genres: '',
          status: 'UNKNOWN',
          rating: null,
          chapters: [],
        },
      ],
      library: [],
      history: [
        {
          source: 'fixture',
          manga_slug: 'existing',
          chapter_id: 'history-1',
          last_page_read: 0,
        },
      ],
    } as unknown as PreviewBackupBody;

    await expect(previewBackupConflicts(backup)).resolves.toEqual({
      matchingTitles: 1,
      addedTitles: 1,
      importedTitles: 2,
      catalogRowsUpdated: 1,
      catalogUpdateExamples: ['fixture · existing: New title'],
      chapterIdentityConflicts: 1,
      chapterIdentityConflictExamples: ['New title (chapter 2)'],
      retainedHistory: 1,
      addedHistory: 0,
    });
    expect(prismaMock.manga.findMany).toHaveBeenCalled();
    expect(prismaMock.chapter.findMany).toHaveBeenCalled();
    expect(prismaMock.history.findMany).toHaveBeenCalled();
    expect(prismaMock.user_library.findMany).not.toHaveBeenCalled();
  });
});
