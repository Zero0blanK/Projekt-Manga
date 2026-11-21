import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { ChapterRowText } from '@/components/manga-detail/chapter-row-text';

/** Read state has to be visible where the row starts, not in a pill at its far end. */
describe('chapter row read state', () => {
  it('dims a read chapter and leads it with a check', () => {
    const { container } = render(<ChapterRowText number={3} title="Chapter 3" read />);
    expect(screen.getByText('Chapter 3')).toHaveClass('text-muted-foreground');
    expect(container.querySelector('svg.lucide-check')).not.toBeNull();
    expect(screen.queryByText(/^read$/i)).toBeNull();
  });

  it('marks an unread chapter with a dot and keeps its title bright', () => {
    const { container } = render(<ChapterRowText number={4} title="Chapter 4" read={false} />);
    expect(screen.getByText('Chapter 4')).toHaveClass('text-foreground', 'font-medium');
    expect(container.querySelector('.rounded-full.bg-primary')).not.toBeNull();
  });

  it('shows how far into a started chapter the reader got', () => {
    const { container } = render(
      <ChapterRowText
        number={5}
        title="Chapter 5"
        read={false}
        progress={{ page: 7, total: 20 }}
      />,
    );
    expect(screen.getByText('Page 7 of 20')).toBeInTheDocument();
    const arc = container.querySelectorAll('circle')[1];
    const [filled, whole] = arc.getAttribute('stroke-dasharray')!.split(' ').map(Number);
    expect(filled / whole).toBeCloseTo(0.35);
  });

  it('falls back to the page alone when the page count is unknown', () => {
    render(
      <ChapterRowText number={6} title="Chapter 6" read={false} progress={{ page: 4, total: 0 }} />,
    );
    expect(screen.getByText('Page 4')).toBeInTheDocument();
  });
});

describe('chapter row scanlation group', () => {
  it('names the group, and says so when the source names none', () => {
    const { rerender } = render(
      <ChapterRowText number={1} title="Chapter 1" read={false} group="Test Scans" />,
    );
    expect(screen.getAllByText('Test Scans').length).toBeGreaterThan(0);
    rerender(<ChapterRowText number={1} title="Chapter 1" read={false} group="" />);
    expect(screen.getAllByText(/Unknown group/).length).toBeGreaterThan(0);
  });
});
