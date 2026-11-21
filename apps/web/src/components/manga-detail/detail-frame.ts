/**
 * The title page's frame, shared by the page itself, the source preview shown while its
 * details load, and the loading skeleton, so nothing moves when the real page arrives.
 *
 * As wide as the other pages' frame (`PAGE_FRAME`), with the cover growing on larger
 * screens so it keeps its weight beside the wider info column.
 */
export const DETAIL_FRAME = 'relative mx-auto w-full max-w-[96rem] px-4 py-6 sm:px-6 lg:px-8';

/** The same frame without its vertical padding, for a status line above the skeleton. */
export const DETAIL_FRAME_X = 'mx-auto w-full max-w-[96rem] px-4 sm:px-6 lg:px-8';

/**
 * On phones the cover sits beside the title instead of above it, and the rest spans the
 * full width below, so the chapter list isn't pushed far down. From md up the info column
 * runs beside the cover.
 */
export const DETAIL_GRID =
  'mt-6 grid grid-cols-[7rem_minmax(0,1fr)] items-start gap-x-4 gap-y-2 sm:grid-cols-[10rem_minmax(0,1fr)] sm:gap-x-6 md:grid-cols-[240px_minmax(0,1fr)] md:grid-rows-[auto_1fr] md:gap-x-8 lg:grid-cols-[280px_minmax(0,1fr)] lg:gap-x-10 xl:grid-cols-[320px_minmax(0,1fr)]';

/** The cover's width at each breakpoint: it fills its grid column. */
export const DETAIL_COVER_WIDTH = 'w-full md:w-[240px] lg:w-[280px] xl:w-[320px]';
