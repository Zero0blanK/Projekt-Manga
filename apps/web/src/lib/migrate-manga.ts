import { migrateManga as apiMigrateManga, type MigrationSummary } from '@projekt-manga/api-client';
import { actions as appActions, getAppState } from './app-store';

/**
 * Switches a series to a different source, carrying over what you'd built up on the old
 * entry: reading progress, shelf, rating, categories and history.
 *
 * All of that happens server-side in a single transaction (see
 * apps/server/src/services/migration.service.ts), so a migration either lands completely
 * or not at all, never half-migrated.
 *
 * What remains client-side is the one piece of state the server doesn't own: this app
 * keeps its own category membership in local storage, keyed by category *name* (see
 * app-store). The server moves its own `manga_category` rows inside the transaction; this
 * mirrors the same move locally so the library UI, which reads from app-store, agrees
 * with it. A failure here can't corrupt anything — the server's migration has already
 * committed, and the local mirror is rebuildable.
 */

export interface MigrationPlan {
  from: { mangaId: string; slug: string; title: string };
  to: { mangaId: string; slug: string; title: string };
  /** Remove the old entry from the library once everything has transferred. */
  removeOld: boolean;
  /** Re-point the title's history rows at the new entry. History keeps its own source and
   * slug, so this preserves *where* each chapter was read while stopping the rows from
   * pointing at an entry that just left the library. Defaults to true. */
  moveHistory?: boolean;
}

export interface MigrationResult extends MigrationSummary {
  /** Categories moved in this app's local membership state. The server moves its own
   * rows separately, inside the transaction. */
  local_categories_moved: number;
}

export async function migrateManga(plan: MigrationPlan): Promise<MigrationResult> {
  const summary = await apiMigrateManga(plan.from.mangaId, plan.to.mangaId, {
    remove_old: plan.removeOld,
    move_history: plan.moveHistory ?? true,
  });

  let local_categories_moved = 0;
  const { categoryMembers } = getAppState();
  for (const [category, members] of Object.entries(categoryMembers)) {
    if (!members.includes(plan.from.mangaId)) continue;
    if (!members.includes(plan.to.mangaId)) {
      appActions.toggleCategoryMember(category, plan.to.mangaId);
    }
    appActions.toggleCategoryMember(category, plan.from.mangaId);
    local_categories_moved++;
  }

  return { ...summary, local_categories_moved };
}

/** One line summarising a migration, for a toast. */
export function describeMigration(result: MigrationResult, toTitle: string): string {
  const parts: string[] = [];
  if (result.chapters_marked > 0) {
    parts.push(`${result.chapters_marked} chapter${result.chapters_marked === 1 ? '' : 's'} read`);
  }
  if (result.state_copied) parts.push('shelf and rating');

  const categories = Math.max(result.categories_moved, result.local_categories_moved);
  if (categories > 0) {
    parts.push(`${categories} categor${categories === 1 ? 'y' : 'ies'}`);
  }
  if (result.history_moved > 0) {
    parts.push(`${result.history_moved} history entr${result.history_moved === 1 ? 'y' : 'ies'}`);
  }

  return parts.length > 0
    ? `Migrated to "${toTitle}" — carried over ${parts.join(', ')}.`
    : `Migrated to "${toTitle}".`;
}
