import { describe, it, expect } from 'vitest';
import { prismaMock } from './mocks/prismaMock.js';
import userChapterStateRepository from '../src/repositories/userChapterState.repository.js';
import userLibraryRepository from '../src/repositories/userLibrary.repository.js';
import userMangaStateRepository from '../src/repositories/userMangaState.repository.js';
import historyRepository from '../src/repositories/history.repository.js';
import categoryRepository from '../src/repositories/category.repository.js';

/**
 * Direct tests of the two documented sync merge rules (see sync.service.ts):
 *   1. Plain last-write-wins by updated_at for every domain except chapter_state.
 *   2. chapter_state's monotonic union — is_read/last_page_read can only advance, never
 *      regress, regardless of which side's updated_at is newer.
 * Covered scenarios: a concurrent edit before either device has synced, and an offline
 * device reconnecting after days (which must not drag reading progress backwards).
 */

describe('chapter_state merge: monotonic union (never regress reading progress)', () => {
  it('keeps the server value when the incoming push is older but reports less progress', async () => {
    const serverUpdatedAt = new Date('2026-08-20T00:00:00Z');
    const staleIncomingUpdatedAt = new Date('2026-08-10T00:00:00Z'); // an offline device, days behind

    prismaMock.user_chapter_state.findUnique.mockResolvedValueOnce({
      id: 'ucs-1',
      user_id: 'user-1',
      chapter_id: 'ch-1',
      is_read: true,
      is_bookmark: false,
      last_page_read: 50,
      updated_at: serverUpdatedAt,
    });
    prismaMock.user_chapter_state.update.mockResolvedValueOnce({});

    await userChapterStateRepository.mergeIncoming('user-1', 'ch-1', {
      is_read: false,
      is_bookmark: true,
      last_page_read: 20,
      updated_at: staleIncomingUpdatedAt,
    });

    expect(prismaMock.user_chapter_state.update).toHaveBeenCalledWith({
      where: { user_id_chapter_id: { user_id: 'user-1', chapter_id: 'ch-1' } },
      data: {
        is_read: true, // OR union — already true server-side, stays true
        last_page_read: 50, // max() — the older push's 20 never overwrites the server's 50
        is_bookmark: false, // server is newer, so is_bookmark follows last-write-wins
      },
    });
  });

  it('advances the server value when the incoming push is newer and reports more progress', async () => {
    const staleServerUpdatedAt = new Date('2026-08-10T00:00:00Z');
    const newerIncomingUpdatedAt = new Date('2026-08-20T00:00:00Z'); // this device read further, offline, then reconnected

    prismaMock.user_chapter_state.findUnique.mockResolvedValueOnce({
      id: 'ucs-1',
      user_id: 'user-1',
      chapter_id: 'ch-1',
      is_read: false,
      is_bookmark: false,
      last_page_read: 5,
      updated_at: staleServerUpdatedAt,
    });
    prismaMock.user_chapter_state.update.mockResolvedValueOnce({});

    await userChapterStateRepository.mergeIncoming('user-1', 'ch-1', {
      is_read: true,
      is_bookmark: true,
      last_page_read: 24,
      updated_at: newerIncomingUpdatedAt,
    });

    expect(prismaMock.user_chapter_state.update).toHaveBeenCalledWith({
      where: { user_id_chapter_id: { user_id: 'user-1', chapter_id: 'ch-1' } },
      data: {
        is_read: true,
        last_page_read: 24,
        is_bookmark: true, // incoming is newer, so is_bookmark follows it
      },
    });
  });
});

describe('user_library merge: plain last-write-wins', () => {
  // The comparison lives in the UPDATE's own WHERE clause rather than in a preceding
  // read — see syncMerge.ts on why a read-then-write lost concurrent edits. These assert
  // the predicate reaches the database, since that is now the only thing enforcing it.
  it('discards a stale push when the server row is already newer', async () => {
    const incomingUpdatedAt = new Date('2026-08-10T00:00:00Z');
    // No row matched `updated_at < incoming`, and the follow-up create hit the unique
    // constraint — together that means "a row exists and it is newer".
    prismaMock.user_library.updateMany.mockResolvedValueOnce({ count: 0 });
    prismaMock.user_library.create.mockRejectedValueOnce({ code: 'P2002' });

    const result = await userLibraryRepository.applyIncoming(
      'user-1',
      'm-1',
      new Date('2026-08-19T00:00:00Z'), // an incoming "remove from library" — but it's stale
      incomingUpdatedAt,
    );

    expect(result).toEqual({ applied: false });
    expect(prismaMock.user_library.updateMany).toHaveBeenCalledWith({
      where: {
        user_id: 'user-1',
        manga_id: 'm-1',
        OR: [
          { edited_at: { lt: incomingUpdatedAt } },
          { edited_at: null, updated_at: { lt: incomingUpdatedAt } },
        ],
      },
      data: { deleted_at: new Date('2026-08-19T00:00:00Z'), edited_at: incomingUpdatedAt },
    });
  });

  it('applies a push that is newer than the server row', async () => {
    const incomingUpdatedAt = new Date('2026-08-20T00:00:00Z');
    prismaMock.user_library.updateMany.mockResolvedValueOnce({ count: 1 });

    const result = await userLibraryRepository.applyIncoming(
      'user-1',
      'm-1',
      incomingUpdatedAt,
      incomingUpdatedAt,
    );

    expect(result).toEqual({ applied: true });
    expect(prismaMock.user_library.updateMany).toHaveBeenCalledWith({
      where: {
        user_id: 'user-1',
        manga_id: 'm-1',
        OR: [
          { edited_at: { lt: incomingUpdatedAt } },
          { edited_at: null, updated_at: { lt: incomingUpdatedAt } },
        ],
      },
      data: { deleted_at: incomingUpdatedAt, edited_at: incomingUpdatedAt },
    });
    // The update matched, so no create is attempted.
    expect(prismaMock.user_library.create).not.toHaveBeenCalled();
  });

  it('creates the row when the server has never seen it', async () => {
    prismaMock.user_library.updateMany.mockResolvedValueOnce({ count: 0 });
    prismaMock.user_library.create.mockResolvedValueOnce({ id: 'ul-1' });

    const result = await userLibraryRepository.applyIncoming(
      'user-1',
      'm-1',
      null,
      new Date('2026-08-20T00:00:00Z'),
    );

    expect(result).toEqual({ applied: true });
    expect(prismaMock.user_library.create).toHaveBeenCalledWith({
      data: { user_id: 'user-1', manga_id: 'm-1', deleted_at: null, edited_at: expect.any(Date) },
    });
  });

  it('does not swallow a real database error as a skipped write', async () => {
    prismaMock.user_library.updateMany.mockResolvedValueOnce({ count: 0 });
    prismaMock.user_library.create.mockRejectedValueOnce({ code: 'P2003' }); // FK violation

    await expect(
      userLibraryRepository.applyIncoming('user-1', 'm-1', null, new Date()),
    ).rejects.toMatchObject({ code: 'P2003' });
  });
});

describe('concurrent edit before either device has synced', () => {
  it('the later-updated_at push wins regardless of network arrival order', async () => {
    // Device A bookmarks at T1; device B, working from the same stale base, unbookmarks
    // at T2 (later) but its push happens to arrive at the server first.
    const t1 = new Date('2026-08-20T10:00:00Z');
    const t2 = new Date('2026-08-20T10:05:00Z');

    // B's push (T2) arrives first — server has no row yet, so it's created.
    prismaMock.user_manga_state.updateMany.mockResolvedValueOnce({ count: 0 });
    prismaMock.user_manga_state.create.mockResolvedValueOnce({ id: 'ums-1' });
    const resultFromB = await userMangaStateRepository.applyIncoming(
      'user-1',
      'm-1',
      { is_bookmarked: false, shelf_status: null, notification_read: false },
      t2,
    );
    expect(resultFromB).toEqual({ applied: true });

    // A's push (T1, older) arrives second. Its UPDATE carries `updated_at < t1`, which
    // B's t2 row does not satisfy, so nothing matches; the create then collides with the
    // existing row. A's edit is discarded without ever reading the row first.
    prismaMock.user_manga_state.updateMany.mockResolvedValueOnce({ count: 0 });
    prismaMock.user_manga_state.create.mockRejectedValueOnce({ code: 'P2002' });
    const resultFromA = await userMangaStateRepository.applyIncoming(
      'user-1',
      'm-1',
      { is_bookmarked: true, shelf_status: null, notification_read: false },
      t1,
    );

    expect(resultFromA).toEqual({ applied: false }); // B's (later) unbookmark survives
    expect(prismaMock.user_manga_state.updateMany).toHaveBeenLastCalledWith({
      where: {
        user_id: 'user-1',
        manga_id: 'm-1',
        OR: [{ edited_at: { lt: t1 } }, { edited_at: null, updated_at: { lt: t1 } }],
      },
      data: { is_bookmarked: true, shelf_status: null, notification_read: false, edited_at: t1 },
    });
  });
});

describe('category find-or-create (resolves a synced category by shared name)', () => {
  it('reuses an existing category rather than creating a duplicate', async () => {
    prismaMock.category.findUnique.mockResolvedValueOnce({ id: 'action', name: 'Action' });

    const result = await categoryRepository.findOrCreateByName('Action');

    expect(result).toEqual({ id: 'action', name: 'Action' });
    expect(prismaMock.category.create).not.toHaveBeenCalled();
  });

  it('creates the category when no device has ever pushed that name before', async () => {
    prismaMock.category.findUnique.mockResolvedValueOnce(null);
    prismaMock.category.create.mockResolvedValueOnce({ id: 'sci-fi', name: 'Sci-Fi' });

    const result = await categoryRepository.findOrCreateByName('Sci-Fi');

    expect(result).toEqual({ id: 'sci-fi', name: 'Sci-Fi' });
    expect(prismaMock.category.create).toHaveBeenCalledWith({
      data: { id: 'sci-fi', name: 'Sci-Fi' },
    });
  });
});

describe('history merge: last-write-wins by last_read', () => {
  it('discards a stale push', async () => {
    const serverRow = {
      id: 'hist-1',
      last_read: new Date('2026-08-20T00:00:00Z'),
      user_id: 'user-1',
    };
    prismaMock.history.findUnique.mockResolvedValueOnce(serverRow);

    const result = await historyRepository.applyIncoming('user-1', {
      id: 'hist-1',
      source: 'mangadex',
      manga_id: 'm-1',
      manga_slug: 'slug',
      title: null,
      thumbnail_url: null,
      chapter_id: 'ch-1',
      read_at: new Date('2026-08-10T00:00:00Z'),
      last_read: new Date('2026-08-10T00:00:00Z'),
      pages_read: 5,
      time_read: 10,
      deleted_at: null,
    });

    expect(result).toEqual(serverRow);
    expect(prismaMock.history.upsert).not.toHaveBeenCalled();
  });

  it('refuses to overwrite a row that belongs to a different account, even with a newer last_read', async () => {
    const otherAccountsRow = {
      id: 'hist-1',
      last_read: new Date('2026-08-10T00:00:00Z'), // older than the incoming push
      user_id: 'someone-elses-user-id',
    };
    prismaMock.history.findUnique.mockResolvedValueOnce(otherAccountsRow);

    await expect(
      historyRepository.applyIncoming('user-1', {
        id: 'hist-1', // a client-generated id that happens to collide with another account's row
        source: 'mangadex',
        manga_id: 'm-1',
        manga_slug: 'slug',
        title: null,
        thumbnail_url: null,
        chapter_id: 'ch-1',
        read_at: new Date('2026-08-20T00:00:00Z'),
        last_read: new Date('2026-08-20T00:00:00Z'), // newer — would win a plain LWW check
        pages_read: 5,
        time_read: 10,
        deleted_at: null,
      }),
    ).rejects.toThrow('History id belongs to another account');
    expect(prismaMock.history.upsert).not.toHaveBeenCalled();
  });
});
