'use client';

import { useRef, useState } from 'react';
import { ClipboardList, Loader2 } from 'lucide-react';
import { buildDiagnosticReport } from '@/lib/diagnostics';
import { copyToClipboard } from '@/lib/clipboard';
import { reportError } from '@/lib/report-error';
import { Textarea } from '@/components/ui/textarea';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';

/**
 * Produces the pasteable report described in lib/diagnostics.ts.
 *
 * Exists because a local install has no logs anyone but the user can see: without this,
 * every bug report is "it doesn't work" from a machine that can't be inspected.
 */
export function DiagnosticReportButton() {
  const [busy, setBusy] = useState(false);
  const [report, setReport] = useState<string | null>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);

  const review = async () => {
    setBusy(true);
    try {
      setReport(await buildDiagnosticReport());
    } catch (error) {
      // buildDiagnosticReport tolerates each source failing individually, so reaching here
      // means something unexpected. Still worth surfacing rather than leaving a dead button.
      reportError(error, "Couldn't build the diagnostic report.");
    } finally {
      setBusy(false);
    }
  };

  return (
    <>
      <button
        ref={triggerRef}
        type="button"
        onClick={() => void review()}
        disabled={busy}
        className="inline-flex items-center gap-2 rounded-full border border-border/60 px-3.5 py-1.5 text-xs font-medium text-foreground transition-colors hover:bg-surface/60 disabled:opacity-60"
      >
        {busy ? (
          <Loader2 className="h-3.5 w-3.5 animate-spin" />
        ) : (
          <ClipboardList className="h-3.5 w-3.5" />
        )}
        {busy ? 'Collecting…' : 'Review diagnostic report'}
      </button>
      <Dialog open={report !== null} onOpenChange={(open) => !open && setReport(null)}>
        <DialogContent
          className="max-h-[85vh] overflow-y-auto sm:max-w-3xl"
          onCloseAutoFocus={(event) => {
            event.preventDefault();
            triggerRef.current?.focus();
          }}
        >
          <DialogHeader>
            <DialogTitle>Review diagnostic report</DialogTitle>
            <DialogDescription>
              Check this report before copying or sharing it. It includes recent server event IDs
              and counts, but omits raw error messages, URLs, and file paths.
            </DialogDescription>
          </DialogHeader>
          <Textarea
            aria-label="Diagnostic report contents"
            readOnly
            value={report ?? ''}
            className="min-h-[45vh] font-mono text-xs"
          />
          <DialogFooter>
            <button
              type="button"
              onClick={() => setReport(null)}
              className="rounded-md border border-border px-4 py-2 text-sm text-foreground hover:bg-muted"
            >
              Close
            </button>
            <button
              type="button"
              disabled={!report}
              onClick={() => report && void copyToClipboard(report, 'Diagnostic report copied.')}
              className="rounded-md bg-primary px-4 py-2 text-sm font-medium text-primary-foreground disabled:opacity-50"
            >
              Copy report
            </button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}
