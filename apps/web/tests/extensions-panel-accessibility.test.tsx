import { beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

const { removeRepository } = vi.hoisted(() => ({ removeRepository: vi.fn() }));

vi.mock('@/lib/extensions-store', () => ({
  extensionActions: {
    addRepository: vi.fn(),
    refreshRepository: vi.fn(),
    removeRepository,
  },
  useExtensionRepositories: () => ({
    loading: false,
    repositories: [
      {
        id: 'repo-1',
        name: 'Fixture repository',
        url: 'https://example.test/index.json',
        sources: [],
      },
    ],
  }),
}));
vi.mock('@/components/settings/field-controls', () => ({
  Panel: ({ children }: { children: React.ReactNode }) => <section>{children}</section>,
  Field: ({ label, children }: { label: string; children: React.ReactNode }) => (
    <div>
      <span>{label}</span>
      {children}
    </div>
  ),
}));

const { ExtensionsPanel } = await import('@/components/settings/extensions-panel');

describe('ExtensionsPanel accessibility', () => {
  beforeEach(() => vi.clearAllMocks());

  it('returns focus to the repository remove trigger when confirmation is cancelled', async () => {
    const user = userEvent.setup();
    render(<ExtensionsPanel />);

    const trigger = screen.getByRole('button', { name: 'Remove' });
    await user.click(trigger);
    expect(
      await screen.findByRole('alertdialog', { name: 'Remove this repository?' }),
    ).toBeVisible();
    await user.click(screen.getByRole('button', { name: 'Cancel' }));

    await waitFor(() => expect(trigger).toHaveFocus());
    expect(removeRepository).not.toHaveBeenCalled();
  });
});
