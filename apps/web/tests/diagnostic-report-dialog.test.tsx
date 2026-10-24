import { beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

const buildDiagnosticReport = vi.fn();
vi.mock('@/lib/diagnostics', () => ({ buildDiagnosticReport: () => buildDiagnosticReport() }));
vi.mock('@/lib/clipboard', () => ({ copyToClipboard: vi.fn() }));
vi.mock('@/lib/report-error', () => ({ reportError: vi.fn() }));

const { DiagnosticReportButton } = await import('@/components/settings/diagnostic-report-button');

describe('diagnostic report dialog', () => {
  beforeEach(() => {
    buildDiagnosticReport.mockReset();
    buildDiagnosticReport.mockResolvedValue('Fixture diagnostic report');
  });

  it('returns focus to the invoking control after closing the report', async () => {
    const user = userEvent.setup();
    render(<DiagnosticReportButton />);
    const trigger = screen.getByRole('button', { name: 'Review diagnostic report' });

    await user.click(trigger);
    expect(await screen.findByRole('dialog', { name: 'Review diagnostic report' })).toBeVisible();
    expect(screen.getByRole('textbox', { name: 'Diagnostic report contents' })).toHaveValue(
      'Fixture diagnostic report',
    );

    await user.click(screen.getByRole('button', { name: 'Close' }));
    await waitFor(() => expect(trigger).toHaveFocus());
  });
});
