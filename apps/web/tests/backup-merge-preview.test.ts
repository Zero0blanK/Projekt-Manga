import { describe, expect, it } from 'vitest';
import { previewBackupMerge, type BackupPayload } from '../src/lib/backup-validation';

describe('previewBackupMerge', () => {
  it('counts titles and rows retained by merge identity rules', () => {
    const backup = {
      version: 2,
      manga: [
        { id: 'import-existing', source: 'source-a', slug: 'existing', chapters: [{}, {}] },
        { id: 'import-new', source: 'source-b', slug: 'new', chapters: [{}] },
      ],
      library: [{ manga_id: 'import-existing' }, { manga_id: 'import-new' }],
      history: [
        { source: 'source-a', manga_slug: 'existing', chapter_id: 'chapter-1' },
        { source: 'source-a', manga_slug: 'existing', chapter_id: 'chapter-2' },
      ],
      downloads: [],
      settings: null,
    } as unknown as BackupPayload;

    expect(
      previewBackupMerge(
        backup,
        [{ source: 'source-a', slug: 'existing' }],
        [{ source: 'source-a', manga_slug: 'existing', chapter_id: 'chapter-1' }],
      ),
    ).toEqual({
      matchingTitles: 1,
      addedTitles: 1,
      skippedChapters: 2,
      skippedLibraryStates: 1,
      retainedHistory: 1,
      addedHistory: 1,
    });
  });

  it('counts repeated import history identities once, matching the merge insertion behavior', () => {
    const backup = {
      version: 2,
      manga: [],
      library: [],
      history: [
        { source: 'source-a', manga_slug: 'title', chapter_id: 'chapter-1' },
        { source: 'source-a', manga_slug: 'title', chapter_id: 'chapter-1' },
      ],
      downloads: [],
      settings: null,
    } as unknown as BackupPayload;
    expect(previewBackupMerge(backup, [], [])).toMatchObject({
      retainedHistory: 1,
      addedHistory: 1,
    });
  });
});
