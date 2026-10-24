'use client';

import { toast } from '@/hooks/use-toast';

/** The desktop shell's own clipboard, when running inside it. Absent in a plain browser. */
function desktopClipboard(): { writeText: (text: string) => Promise<unknown> } | null {
  if (typeof window === 'undefined') return null;
  return (
    (
      window as unknown as {
        desktop?: { clipboard?: { writeText: (t: string) => Promise<unknown> } };
      }
    ).desktop?.clipboard ?? null
  );
}

/**
 * Copies text and only claims success once the write actually succeeded.
 *
 * Toasting "Copied" without awaiting `navigator.clipboard.writeText(...)` works on
 * localhost but lies elsewhere: the Clipboard API requires a secure context, so serving
 * this app over plain HTTP on a LAN address (a normal way to reach a self-hosted install
 * from a phone or another machine) rejects the write while the reader is told it worked.
 */
export async function copyToClipboard(text: string, successMessage: string): Promise<boolean> {
  /**
   * The desktop app copies through Electron, not `navigator.clipboard`.
   *
   * The web API additionally requires the *document to be focused*, and rejects with
   * `NotAllowedError: Document is not focused` when it is not. In a desktop app that is a
   * routine state — DevTools focused, or the click that arrives on the way in from another
   * window — which would surface a spurious "browser blocked it" error. Electron's
   * clipboard has no focus requirement.
   */
  const desktop = desktopClipboard();
  if (desktop) {
    try {
      await desktop.writeText(text);
      toast({ description: successMessage });
      return true;
    } catch {
      // Fall through to the web API rather than failing outright: the bridge being present
      // does not guarantee the main process answered, and the web path still works when the
      // window happens to be focused.
    }
  }

  const clipboard = typeof navigator !== 'undefined' ? navigator.clipboard : undefined;

  if (!clipboard) {
    toast({
      variant: 'destructive',
      description: 'Copying needs a secure connection (https, or localhost).',
    });
    return false;
  }

  try {
    await clipboard.writeText(text);
    toast({ description: successMessage });
    return true;
  } catch {
    // Denied permission, a non-secure origin, or a browser that refuses outside a direct
    // user gesture. The reader can still select the link by hand, so this says what
    // happened rather than pretending nothing did.
    toast({
      variant: 'destructive',
      description: "Couldn't copy to the clipboard — your browser blocked it.",
    });
    return false;
  }
}
