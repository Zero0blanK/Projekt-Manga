import { describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';

vi.mock('@/components/notifications/chapter-updates', () => ({
  ChapterUpdates: () => <div>Chapter updates content</div>,
}));
vi.mock('@/components/notifications/update-log', () => ({
  UpdateLog: () => <div>Update log content</div>,
}));

const { NotificationsPageClient } = await import('@/app/notifications/client');

describe('notification tabs', () => {
  it('announces selection and supports arrow-key navigation', () => {
    render(<NotificationsPageClient />);
    const chapters = screen.getByRole('tab', { name: 'New chapters' });
    const log = screen.getByRole('tab', { name: 'Update log' });
    expect(chapters).toHaveAttribute('aria-selected', 'true');
    expect(log).toHaveAttribute('aria-selected', 'false');

    chapters.focus();
    fireEvent.keyDown(chapters, { key: 'ArrowRight' });
    expect(log).toHaveFocus();
    expect(log).toHaveAttribute('aria-selected', 'true');
    expect(screen.getByRole('tabpanel', { name: 'Update log' })).toHaveTextContent(
      'Update log content',
    );
    fireEvent.keyDown(log, { key: 'Home' });
    expect(chapters).toHaveFocus();
    expect(chapters).toHaveAttribute('aria-selected', 'true');
  });
});
