/**
 * The chapter heading, search, filters and sort, held under the floating top nav while the
 * list scrolls. Its `top` is read back by lib/chapter-window.ts to keep a row reached by
 * the arrow keys out from under it.
 */
export const CHAPTER_TOOLBAR_CLASS =
  'sticky top-[4.75rem] z-20 -mx-3 rounded-b-xl bg-background/95 px-3 py-2 backdrop-blur';

/** One scrollable line on a phone, so the held toolbar doesn't eat half the screen. */
export const CHAPTER_CONTROLS_CLASS =
  'flex max-w-full items-center gap-2 overflow-x-auto [scrollbar-width:none] sm:flex-wrap sm:overflow-visible [&::-webkit-scrollbar]:hidden [&>*]:shrink-0';

/**
 * Whether a chapter's title already names its number ("Chapter 254", "Ch. 254 - Finale"),
 * so the row needn't repeat it. A custom name ("The Final Battle") doesn't, and keeps the
 * number beside it.
 */
export function titleShowsNumber(title: string, chapterNumber: number): boolean {
  if (!Number.isFinite(chapterNumber)) return false;
  const number = String(chapterNumber).replace('.', '\\.');
  // "Chapter 25" must not count as naming chapter 2, nor "Chapter 2.5" as chapter 2.
  return new RegExp(`(?:^|[^a-z])(?:chapter|ch\\.?)\\s*0*${number}(?![\\d]|\\.\\d)`, 'i').test(
    title,
  );
}
