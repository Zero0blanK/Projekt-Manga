'use client';

import { useCallback, useRef } from 'react';
import type { BulkMarkResult } from '@projekt-manga/api-client';
import { toast } from '@/hooks/use-toast';
import { toastWithUndo } from '@/lib/undo-toast';

/**
 * Marking chapters read and unread from a chapter list: one chapter, or everything up to
 * one. The list shows the change at once and this keeps it honest afterwards.
 *
 * Both chapter lists (a library title's, and a source's) use it, so the rules are the same
 * in each:
 * - A mark that fails puts back only its own chapters, and only those no newer mark has
 *   touched since. Restoring a whole earlier snapshot would erase marks made meanwhile.
 * - A bulk mark the server applied in part keeps what was saved, puts back what was not,
 *   and says how many failed instead of offering an undo for a result it did not get.
 * - Nothing is written, shown or toasted for a list that has since moved to another title
 *   or another account.
 *
 * What differs between the lists is how rows are held and what else a mark sets off; each
 * says so through {@link ChapterMarkingAdapter}.
 */
export interface ChapterMarkingAdapter<Row> {
  /**
   * Called as a mark starts. Null refuses it (busy, signed-out mid-switch). Otherwise the
   * returned function answers, later, whether the list is still showing the same title to
   * the same account.
   */
  begin: () => (() => boolean) | null;
  /** The rows as the list holds them now. */
  rows: () => readonly Row[];
  /** What a row is tracked by, for telling one chapter's marks apart. */
  id: (row: Row) => string;
  /** The source's key for the chapter, as the server names the ones a bulk mark missed. */
  sourceKey: (row: Row) => string;
  chapterNumber: (row: Row) => number;
  isRead: (row: Row) => boolean;
  /** Shows the given chapters (by `id`) as read or unread. */
  setRead: (changes: ReadonlyMap<string, boolean>) => void;
  /** Saves one chapter's read state. */
  mark: (row: Row, read: boolean) => Promise<unknown>;
  /** Saves many at once. */
  markMany: (rows: Row[], read: boolean) => Promise<BulkMarkResult | void>;
  /** After one chapter was saved. Runs even if the list has moved on: check `still()`. */
  onMarked?: (row: Row, read: boolean, still: () => boolean) => void;
  /** After a bulk mark was saved, in whole or in part. */
  onManyMarked?: () => void;
  /** Takes back a bulk mark of exactly these rows. A rejection tells the reader. */
  undoMany: (rows: Row[], read: boolean, still: () => boolean) => Promise<void>;
}

export function useChapterMarking<Row>(adapter: ChapterMarkingAdapter<Row>) {
  // The adapter closes over the list's latest state; a mark must read it as it is when the
  // mark runs, not as it was when this hook last rendered.
  const adapterRef = useRef(adapter);
  adapterRef.current = adapter;

  // Every mark takes the next version for each chapter it touches. A chapter belongs to
  // whichever mark holds its latest version, and only that mark may put it back.
  const nextVersion = useRef(0);
  const latest = useRef(new Map<string, number>());
  const claim = (ids: string[]): Map<string, number> => {
    const versions = new Map<string, number>();
    for (const id of ids) {
      const version = ++nextVersion.current;
      versions.set(id, version);
      latest.current.set(id, version);
    }
    return versions;
  };
  const owned = (versions: Map<string, number>): string[] =>
    [...versions].filter(([id, version]) => latest.current.get(id) === version).map(([id]) => id);
  const release = (versions: Map<string, number>) => {
    for (const id of owned(versions)) latest.current.delete(id);
  };

  /** Forgets marks in flight: for a list that now shows another title or account. */
  const reset = useCallback(() => latest.current.clear(), []);

  /**
   * Flips one chapter. Resolves true once saved, false when it failed (and was put back)
   * or the list moved on; undefined when it was refused at the start.
   */
  const toggleRead = (row: Row): Promise<boolean> | undefined => {
    const a = adapterRef.current;
    const still = a.begin();
    if (!still) return undefined;
    const id = a.id(row);
    const wasRead = a.isRead(row);
    const versions = claim([id]);
    a.setRead(new Map([[id, !wasRead]]));

    let saved = false;
    return a
      .mark(row, !wasRead)
      .then(() => {
        saved = still();
        a.onMarked?.(row, !wasRead, still);
      })
      .catch(() => {
        if (!still()) return;
        if (owned(versions).length > 0) a.setRead(new Map([[id, wasRead]]));
        toast({ description: "Couldn't update chapter — try again" });
      })
      .finally(() => {
        if (still()) release(versions);
      })
      .then(() => saved);
  };

  /**
   * Marks the chapter and everything before it: inclusive, matching "I've read up to
   * here". Only chapters that would change are sent, so going over an already-read run is
   * a no-op and not a burst of redundant writes.
   */
  const markPrevious = (row: Row, read: boolean): void => {
    const a = adapterRef.current;
    const still = a.begin();
    if (!still) return;
    const upTo = a.chapterNumber(row);
    const targets = a
      .rows()
      .filter((other) => a.chapterNumber(other) <= upTo && a.isRead(other) !== read);
    if (targets.length === 0) {
      toast({
        description: read
          ? 'Everything up to here is already read'
          : 'Everything up to here is already unread',
      });
      return;
    }

    const versions = claim(targets.map(a.id));
    a.setRead(new Map(targets.map((target) => [a.id(target), read])));
    // Every target was in the other state, or it would not be one.
    const putBack = (ids: string[]) => {
      if (ids.length > 0) a.setRead(new Map(ids.map((id) => [id, !read])));
    };

    void a
      .markMany(targets, read)
      .then((result) => {
        if (!still()) return;
        a.onManyMarked?.();
        const failedKeys = new Set(result?.failed_source_chapter_keys ?? []);
        if (failedKeys.size > 0) {
          const failedIds = new Set(
            targets.filter((target) => failedKeys.has(a.sourceKey(target))).map(a.id),
          );
          putBack(owned(versions).filter((id) => failedIds.has(id)));
          toast({
            description: `Updated ${result?.count ?? targets.length - failedKeys.size} chapters; ${failedKeys.size} failed`,
          });
          return;
        }
        toastWithUndo(
          `Marked ${targets.length} chapter${targets.length === 1 ? '' : 's'} as ${
            read ? 'read' : 'unread'
          }`,
          () => a.undoMany(targets, read, still),
        );
      })
      .catch(() => {
        if (!still()) return;
        putBack(owned(versions));
        toast({ description: "Couldn't mark previous chapters — try again" });
      })
      .finally(() => {
        if (still()) release(versions);
      });
  };

  return { toggleRead, markPrevious, reset };
}
