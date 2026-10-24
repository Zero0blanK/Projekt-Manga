import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
const mocks = vi.hoisted(() => ({ addRepository: vi.fn(), repositories: [] as { url: string }[] }));
vi.mock('@/lib/session-resource', () => ({
  useCurrentUser: () => ({ user: null, loading: false }),
}));
vi.mock('@/lib/extensions-store', () => ({
  extensionActions: { addRepository: mocks.addRepository },
  useExtensionRepositories: () => ({ repositories: mocks.repositories }),
}));
vi.mock('@/hooks/use-toast', () => ({ toast: vi.fn() }));
import { FirstUseSetup } from '@/components/discover/first-use-setup';
import { actions } from '@/lib/app-store';
import { queryClient, queryKeys } from '@/lib/query-client';
beforeEach(() => {
  vi.clearAllMocks();
  actions.resetAll();
  queryClient.clear();
  queryClient.setQueryData(queryKeys.session, null);
  mocks.repositories = [];
  mocks.addRepository.mockResolvedValue(undefined);
});
afterEach(() => {
  cleanup();
  actions.resetAll();
  queryClient.clear();
});
describe('Anonymous source onboarding resume and recovery', () => {
  it('remembers chosen languages and resumes the same step after leaving setup', () => {
    const onLanguages = vi.fn();
    const { unmount } = render(<FirstUseSetup installedCount={0} onLanguages={onLanguages} />);
    fireEvent.click(screen.getByRole('checkbox', { name: 'French' }));
    fireEvent.click(screen.getByRole('checkbox', { name: 'Indonesian' }));
    fireEvent.click(screen.getByRole('button', { name: 'Continue' }));
    expect(onLanguages).toHaveBeenCalledWith(['fr', 'id']);
    fireEvent.click(screen.getByRole('button', { name: 'Skip setup' }));
    unmount();
    onLanguages.mockClear();
    render(<FirstUseSetup installedCount={0} onLanguages={onLanguages} />);
    expect(onLanguages).toHaveBeenCalledWith(['fr', 'id']);
    fireEvent.click(screen.getByRole('button', { name: 'Resume source setup' }));
    expect(screen.getByText(/Step 2 of 4/)).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Back' }));
    expect(screen.getByRole('checkbox', { name: 'French' })).toBeChecked();
    expect(screen.getByRole('checkbox', { name: 'Indonesian' })).toBeChecked();
  });
  it('retains a failed repository step for retry and requires an installed source', async () => {
    mocks.addRepository.mockRejectedValueOnce(new Error('unavailable'));
    const { rerender } = render(<FirstUseSetup installedCount={0} onLanguages={vi.fn()} />);
    fireEvent.click(screen.getByRole('button', { name: 'Continue' }));
    fireEvent.change(screen.getByRole('textbox', { name: 'Repository index URL' }), {
      target: { value: 'https://example.com/index.json' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Add repository' }));
    await waitFor(() =>
      expect(screen.getByRole('button', { name: 'Add repository' })).toBeEnabled(),
    );
    expect(screen.getByText(/Step 2 of 4/)).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Add repository' }));
    expect(await screen.findByRole('button', { name: 'Continue with 0 installed' })).toBeDisabled();
    expect(mocks.addRepository).toHaveBeenCalledTimes(2);
    rerender(<FirstUseSetup installedCount={1} onLanguages={vi.fn()} />);
    fireEvent.click(screen.getByRole('button', { name: 'Continue with 1 installed' }));
    expect(screen.getByText(/Step 4 of 4/)).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Finish setup' }));
    expect(screen.getByRole('button', { name: 'Resume source setup' })).toBeInTheDocument();
  });
  it('uses an existing repository without adding a duplicate', () => {
    mocks.repositories = [{ url: 'https://example.com/index.json' }];
    render(<FirstUseSetup installedCount={1} onLanguages={vi.fn()} />);
    fireEvent.click(screen.getByRole('button', { name: 'Continue' }));
    fireEvent.click(screen.getByRole('button', { name: 'Use existing repositories' }));
    expect(screen.getByText(/Step 3 of 4/)).toBeInTheDocument();
    expect(mocks.addRepository).not.toHaveBeenCalled();
  });
});
