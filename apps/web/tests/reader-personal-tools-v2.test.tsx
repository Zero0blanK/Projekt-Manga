import { fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ReaderPersonalTools } from '@/components/reader/reader-personal-tools';
import { actions, getAppState } from '@/lib/app-store';
import { queryClient, queryKeys } from '@/lib/query-client';
import { profilePreferenceKey } from '@/lib/profile-preferences';

const identity = vi.hoisted(() => ({ user: { id: 'a' }, loading: false }));
vi.mock('@/lib/session-resource', () => ({ useCurrentUser: () => identity }));
vi.mock('@/lib/reader-settings', () => ({
  useReaderSettings: () => ({
    pageLayout: 'Single page',
    readingDirection: 'Right to left',
    zoomBehavior: 'Smart',
    brightness: 100,
    stripGap: 8,
    pagePrefetchAhead: 4,
    chapterPrefetchCount: 1,
  }),
}));

beforeEach(() => {
  actions.resetAll();
  queryClient.clear();
  identity.user = { id: 'a' };
  identity.loading = false;
  queryClient.setQueryData(queryKeys.session, identity.user);
});
afterEach(() => vi.restoreAllMocks());

function tools(page = 1) {
  return <ReaderPersonalTools source="fixture" mangaId="title" chapterId="release-b" page={page} />;
}

describe('reader personal tools ownership', () => {
  it('saves, applies and clears a title preset without changing another title override', () => {
    render(tools());
    fireEvent.click(screen.getByRole('button', { name: 'Notes & presets' }));
    fireEvent.change(screen.getByRole('textbox', { name: 'Preset name' }), {
      target: { value: 'Comfortable' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Save current settings' }));
    fireEvent.click(screen.getByRole('button', { name: 'Apply to this title' }));
    expect(screen.getByRole('status')).toHaveTextContent('This title uses Comfortable.');
    const key = profilePreferenceKey('reader-override:fixture:title', 'a');
    expect(JSON.parse(String(getAppState().settings[key])).value.name).toBe('Comfortable');
    expect(
      getAppState().settings[profilePreferenceKey('reader-override:fixture:other', 'a')],
    ).toBeUndefined();
    fireEvent.click(screen.getByRole('button', { name: 'Use global settings for this title' }));
    expect(JSON.parse(String(getAppState().settings[key])).value).toBeNull();
  });

  it('exports only this title in the active profile as a JSON download', async () => {
    const note = {
      source: 'fixture',
      mangaId: 'title',
      chapterId: 'release-b',
      page: 1,
      text: 'Own note',
    };
    actions.setSetting(
      profilePreferenceKey('page-notes', 'a'),
      JSON.stringify({
        version: 1,
        value: [note, { ...note, mangaId: 'other', text: 'Other title' }],
      }),
    );
    actions.setSetting(
      profilePreferenceKey('page-notes', 'b'),
      JSON.stringify({ version: 1, value: [{ ...note, text: 'Other profile' }] }),
    );
    const create = vi.fn().mockReturnValue('blob:fixture');
    vi.stubGlobal('URL', Object.assign(URL, { createObjectURL: create, revokeObjectURL: vi.fn() }));
    const click = vi
      .spyOn(HTMLAnchorElement.prototype, 'click')
      .mockImplementation(() => undefined);
    render(tools());
    fireEvent.click(screen.getByRole('button', { name: 'Notes & presets' }));
    fireEvent.click(screen.getByRole('button', { name: "Export this title's notes" }));
    expect(click).toHaveBeenCalledOnce();
    expect(create.mock.calls[0][0]).toBeInstanceOf(Blob);
    expect(create.mock.calls[0][0].type).toBe('application/json');
    const exported = await new Promise<string>((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => resolve(String(reader.result));
      reader.onerror = () => reject(reader.error);
      reader.readAsText(create.mock.calls[0][0]);
    });
    expect(JSON.parse(exported)).toEqual([note]);
    expect(document.querySelector('a[download="page-notes.json"]')).not.toBeInTheDocument();
    vi.unstubAllGlobals();
  });
  it('discards unsaved notes and preset names when the account changes', () => {
    const { rerender } = render(tools());
    fireEvent.click(screen.getByRole('button', { name: 'Notes & presets' }));
    fireEvent.change(screen.getByRole('textbox', { name: 'Note for page 1' }), {
      target: { value: 'Private A draft' },
    });
    fireEvent.change(screen.getByRole('textbox', { name: 'Preset name' }), {
      target: { value: 'Private A preset' },
    });
    identity.user = { id: 'b' };
    queryClient.setQueryData(queryKeys.session, identity.user);
    rerender(tools());
    fireEvent.click(screen.getByRole('button', { name: 'Notes & presets' }));
    expect(screen.getByRole('textbox', { name: 'Note for page 1' })).toHaveValue('');
    expect(screen.getByRole('textbox', { name: 'Preset name' })).toHaveValue('');
    expect(screen.getByRole('button', { name: 'Save note' })).toBeDisabled();
    expect(getAppState().settings[profilePreferenceKey('page-notes', 'b')]).toBeUndefined();
  });

  it('retains literal note text for the exact release and page and discards a draft after seeking', () => {
    const { rerender } = render(tools());
    fireEvent.click(screen.getByRole('button', { name: 'Notes & presets' }));
    fireEvent.change(screen.getByRole('textbox', { name: 'Note for page 1' }), {
      target: { value: '<script>literal</script>' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Save note' }));
    expect(screen.getByText('<script>literal</script>', { selector: 'p' })).toBeInTheDocument();
    expect(
      JSON.parse(String(getAppState().settings[profilePreferenceKey('page-notes', 'a')])).value,
    ).toEqual([
      {
        source: 'fixture',
        mangaId: 'title',
        chapterId: 'release-b',
        page: 1,
        text: '<script>literal</script>',
      },
    ]);
    rerender(tools(2));
    fireEvent.click(screen.getByRole('button', { name: 'Notes & presets' }));
    expect(screen.getByRole('textbox', { name: 'Note for page 2' })).toHaveValue('');
  });
});
