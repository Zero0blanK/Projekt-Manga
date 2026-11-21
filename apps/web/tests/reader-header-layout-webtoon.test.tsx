import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { actions, getAppState } from '@/lib/app-store';
import { queryClient, queryKeys } from '@/lib/query-client';
import { profilePreferenceKey } from '@/lib/profile-preferences';
import { useReaderSettings } from '@/lib/reader-settings';
import { resolveWebtoonLayout } from '@/lib/webtoon-layout';
import { ReaderSettingsMenu } from '@/components/reader/reader-settings-menu';
import { useTitleLayoutChoice } from '@/components/reader/use-title-layout-choice';

vi.mock('@/lib/session-resource', () => ({
  useCurrentUser: () => ({ user: { id: 'a' }, loading: false }),
}));
vi.mock('@/hooks/use-toast', () => ({ toast: vi.fn() }));

/**
 * The reader page's layout wiring (`reader/[id]/client.tsx`), with the real settings,
 * webtoon resolution, per-title choice and header menu: the page itself needs a manga,
 * fetched chapters and pages to render at all.
 */
function Reader({ webtoon }: { webtoon: boolean }) {
  const settings = useReaderSettings('src', 'm1');
  const effectiveLayout = resolveWebtoonLayout({
    layout: settings.effectiveLayout,
    webtoon,
    titleLayout: settings.titlePageLayout,
  });
  const choose = useTitleLayoutChoice({
    source: 'src',
    mangaId: 'm1',
    autoLongStrip: effectiveLayout === 'Long strip' && settings.effectiveLayout !== 'Long strip',
    readingDirection: settings.readingDirection,
    base: {
      zoomBehavior: settings.zoomBehavior,
      brightness: settings.brightness,
      stripGap: settings.stripGap,
      pagePrefetchAhead: settings.pagePrefetchAhead,
      chapterPrefetchCount: settings.chapterPrefetchCount,
      colorFilter: settings.colorFilter,
      tint: settings.tint,
      tintStrength: settings.tintStrength,
    },
  });
  return (
    <>
      <output data-testid="layout">{effectiveLayout}</output>
      <ReaderSettingsMenu onChooseLayout={choose} currentLayout={effectiveLayout} />
    </>
  );
}

const overrideKey = profilePreferenceKey('reader-override:src:m1', 'a');
const storedOverride = () => {
  const raw = getAppState().settings[overrideKey];
  return typeof raw === 'string' ? JSON.parse(raw).value : null;
};

async function pick(layout: string) {
  const user = userEvent.setup();
  await user.click(screen.getByRole('button', { name: 'Reader settings' }));
  await user.click(await screen.findByRole('menuitem', { name: layout }));
}

beforeEach(() => {
  actions.resetAll();
  queryClient.clear();
  queryClient.setQueryData(queryKeys.session, { id: 'a' });
  actions.setSetting('pageLayout', 'Single page');
});
afterEach(() => {
  cleanup();
  actions.resetAll();
  queryClient.clear();
});

describe('the reader header layout menu', () => {
  it('on a webtoon opened as a long strip automatically, a paged choice is saved for the title', async () => {
    render(<Reader webtoon />);
    expect(screen.getByTestId('layout').textContent).toBe('Long strip');

    await pick('Two-page spread');

    expect(screen.getByTestId('layout').textContent).toBe('Two-page spread');
    expect(storedOverride()).toMatchObject({
      name: 'Page by page',
      pageLayout: 'Two-page spread',
    });
    // The global layout, set for every title, is left as it was.
    expect(getAppState().settings.pageLayout).toBe('Single page');
  });

  it('keeps a paged choice when the title is opened again', async () => {
    const first = render(<Reader webtoon />);
    await pick('Single page');
    first.unmount();

    render(<Reader webtoon />);
    expect(screen.getByTestId('layout').textContent).toBe('Single page');
  });

  it('on any other title, changes the global layout and saves nothing for the title', async () => {
    render(<Reader webtoon={false} />);
    expect(screen.getByTestId('layout').textContent).toBe('Single page');

    await pick('Two-page spread');

    expect(screen.getByTestId('layout').textContent).toBe('Two-page spread');
    expect(getAppState().settings.pageLayout).toBe('Two-page spread');
    expect(storedOverride()).toBeNull();
  });

  it('choosing the long strip on a webtoon still sets the global layout', async () => {
    render(<Reader webtoon />);
    await pick('Long strip');
    expect(getAppState().settings.pageLayout).toBe('Long strip');
    expect(storedOverride()).toBeNull();
  });
});
