import { describe, expect, it, vi, beforeEach } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';

const { back, push, addRepository } = vi.hoisted(() => ({
  back: vi.fn(),
  push: vi.fn(),
  addRepository: vi.fn(),
}));
vi.mock('next/navigation', () => ({ useRouter: () => ({ back, push }) }));
vi.mock('@/lib/nav-history', () => ({ hasNavigatedInApp: () => true }));
vi.mock('@/lib/extensions-store', () => ({ extensionActions: { addRepository } }));
vi.mock('@/hooks/use-toast', () => ({ toast: vi.fn() }));

const { ExitReaderButton } = await import('@/components/reader/exit-reader-button');
const { AddRepositoryForm } = await import('@/components/extensions/add-repository-form');
const { PROJEKTMANGA_SOURCES_URL, repositoryUrlProblem } = await import('@/lib/repository-url');
const { ApiError } = await import('@projekt-manga/api-client');

beforeEach(() => vi.clearAllMocks());

describe('ExitReaderButton', () => {
  it('leaves the reader on Escape when asked to', async () => {
    render(
      <ExitReaderButton fallbackHref="/manga/1" label="Close reader" escapeKey>
        x
      </ExitReaderButton>,
    );
    await waitFor(() => {
      fireEvent.keyDown(window, { key: 'Escape' });
      expect(back).toHaveBeenCalledOnce();
    });
  });

  it('lets an open menu take Escape first', () => {
    render(
      <>
        <div role="menu" />
        <ExitReaderButton fallbackHref="/manga/1" label="Close reader" escapeKey>
          x
        </ExitReaderButton>
      </>,
    );
    fireEvent.keyDown(window, { key: 'Escape' });
    expect(back).not.toHaveBeenCalled();
  });

  it('ignores Escape without the option, so two exit buttons never navigate twice', () => {
    render(
      <ExitReaderButton fallbackHref="/manga/1" label="Exit reader">
        x
      </ExitReaderButton>,
    );
    fireEvent.keyDown(window, { key: 'Escape' });
    expect(back).not.toHaveBeenCalled();
  });
});

describe('repository URLs', () => {
  it('explains an address that is not a URL before sending anything', () => {
    expect(repositoryUrlProblem('not a url')).toMatch(/full address/);
    expect(repositoryUrlProblem('ftp://example.com/index.json')).toMatch(/https/);
    expect(repositoryUrlProblem('https://example.com/index.json')).toBeNull();
  });

  it('shows a rejected repository under the field instead of "Validation failed"', async () => {
    addRepository.mockRejectedValueOnce(new ApiError('Validation failed', 400, 'http'));
    render(<AddRepositoryForm existingUrls={[]} />);
    fireEvent.change(screen.getByLabelText('Repository address'), {
      target: { value: 'https://example.com/nope.json' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Add' }));
    expect(await screen.findByRole('alert')).toHaveTextContent(/point at the repository/);
  });

  it('offers the project repository in one click until it is added', async () => {
    addRepository.mockResolvedValueOnce(undefined);
    const { rerender } = render(<AddRepositoryForm existingUrls={[]} />);
    fireEvent.click(screen.getByRole('button', { name: 'Add ProjektManga sources' }));
    await waitFor(() => expect(addRepository).toHaveBeenCalledWith(PROJEKTMANGA_SOURCES_URL));
    rerender(<AddRepositoryForm existingUrls={[PROJEKTMANGA_SOURCES_URL]} />);
    expect(screen.queryByRole('button', { name: 'Add ProjektManga sources' })).toBeNull();
  });
});
