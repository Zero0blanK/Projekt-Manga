import { describe, expect, it, vi, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';

const { summary } = vi.hoisted(() => ({
  summary: {
    value: null as { fraction: number; remaining: number; title: string } | null,
  },
}));

vi.mock('@/components/downloads/row-data', () => ({
  useDownloadQueueSummary: () => summary.value,
}));

const { DownloadDial } = await import('@/components/downloads/download-dial');

beforeEach(() => {
  summary.value = null;
});

describe('download dial', () => {
  it('shows nothing while the queue is idle', () => {
    const { container } = render(<DownloadDial />);
    expect(container).toBeEmptyDOMElement();
  });

  it('reports the queue and can shrink to its ring', () => {
    summary.value = { fraction: 0.5, remaining: 3, title: 'One Piece' };
    render(<DownloadDial />);
    expect(screen.getByRole('status')).toHaveTextContent('Downloading 3 chapters');
    expect(screen.getByText('One Piece')).toBeInTheDocument();
    expect(screen.getByText('50%')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Minimize downloads' })).toBeInTheDocument();
  });
});
