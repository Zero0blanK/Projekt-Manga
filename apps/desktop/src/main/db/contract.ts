// The `resolution-mode` attribute is required, not optional styling: this workspace is
// CommonJS (module: Node16) while api-client is an ES module, and under Node16
// resolution TypeScript needs to be told which resolution mode to read its types in.
// Types only, so nothing is emitted either way.
import type {
  MangaListItem,
  MangaWithDetails,
  HistoryEntry,
} from '@projekt-manga/api-client' with { 'resolution-mode': 'import' };
import type { LocalMangaListItem, LocalMangaDetails, LocalHistoryEntry } from './local-store';

/**
 * Compile-time proof that what the local database hands the renderer is what the renderer
 * expects.
 *
 * `packages/api-client` swaps a handful of calls — `getManga`, `getMangaDetailsById`,
 * chapter mark-read, `getHistory`/`addHistory` — from HTTP to this app's local SQLite
 * store whenever `hasLocalDataBridge()` is true (see runtime.ts). The renderer can't tell
 * which transport answered, so the local store has to return the *same shape* the
 * endpoint would. Drift between the two is invisible in a browser and only breaks the
 * desktop build (e.g. a missing `manga_detail` blanks status pills, genres and synopsis);
 * this file turns that class of bug into a failed build.
 *
 * Types only — every import above is `import type`, so this file emits no JavaScript and
 * the Electron main process gains no runtime dependency on api-client. Keep it that way:
 * a value import here would pull the HTTP client into the main bundle.
 */

/**
 * Fails to compile unless `Actual` is assignable to `Contract`.
 *
 * Assignability, not equality, is the right relation: the local shapes legitimately carry
 * extra fields the endpoints don't (and TypeScript allows that through an alias), while
 * every field the renderer *reads* must be present and correctly typed.
 */
type AssertSatisfies<Contract, Actual extends Contract> = Actual;

/**
 * What `getManga()` returns specifically, as opposed to what every list endpoint shares.
 *
 * `manga_detail` is optional on MangaListItem because GET /manga/category/:id omits it —
 * but GET /manga, the call the local store actually stands in for, always populates it.
 * Asserting against the loose type is not enough: dropping manga_detail from the local
 * shape would still compile. Requiring it here is what catches that.
 */
type GetMangaListItem = Omit<MangaListItem, 'manga_detail'> & {
  manga_detail: NonNullable<MangaListItem['manga_detail']>;
};

/** `getManga()` — the library grid, rails, bookmarks and the duplicate-detection scan. */
export type LocalMangaListItemSatisfiesContract = AssertSatisfies<
  GetMangaListItem,
  LocalMangaListItem
>;

/** `getMangaDetailsById()` — the manga detail page and its chapter list. */
export type LocalMangaDetailsSatisfiesContract = AssertSatisfies<
  MangaWithDetails,
  LocalMangaDetails
>;

/** `getHistory()` and `addHistory()` — the history and recents screens. */
export type LocalHistoryEntrySatisfiesContract = AssertSatisfies<HistoryEntry, LocalHistoryEntry>;
