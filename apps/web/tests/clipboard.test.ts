import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const toast = vi.fn();
vi.mock('@/hooks/use-toast', () => ({ toast: (...a: unknown[]) => toast(...a) }));

const { copyToClipboard } = await import('@/lib/clipboard');

const originalClipboard = Object.getOwnPropertyDescriptor(globalThis.navigator, 'clipboard');

function setClipboard(value: unknown) {
  Object.defineProperty(globalThis.navigator, 'clipboard', {
    value,
    configurable: true,
    writable: true,
  });
}

beforeEach(() => {
  vi.clearAllMocks();
});

afterEach(() => {
  if (originalClipboard) {
    Object.defineProperty(globalThis.navigator, 'clipboard', originalClipboard);
  }
});

/**
 * The success toast must follow the awaited write. The Clipboard API needs a secure
 * context, so a self-hosted install reached over plain HTTP on a LAN address rejects the
 * write, and the reader must not be told it worked.
 */
describe('copyToClipboard', () => {
  it('confirms only after the write actually succeeds', async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    setClipboard({ writeText });

    const ok = await copyToClipboard('https://example.test/x', 'Link copied');

    expect(ok).toBe(true);
    expect(writeText).toHaveBeenCalledWith('https://example.test/x');
    expect(toast).toHaveBeenCalledWith({ description: 'Link copied' });
  });

  it('reports a rejected write instead of claiming success', async () => {
    setClipboard({ writeText: vi.fn().mockRejectedValue(new Error('NotAllowedError')) });

    const ok = await copyToClipboard('x', 'Link copied');

    expect(ok).toBe(false);
    const arg = toast.mock.calls[0][0];
    expect(arg.variant).toBe('destructive');
    expect(arg.description).toContain("Couldn't copy");
  });

  it('explains the secure-context requirement when the API is absent entirely', async () => {
    setClipboard(undefined);

    const ok = await copyToClipboard('x', 'Link copied');

    expect(ok).toBe(false);
    expect(toast.mock.calls[0][0].description).toContain('secure connection');
  });

  it('never claims success on a failure path', async () => {
    setClipboard({ writeText: vi.fn().mockRejectedValue(new Error('denied')) });

    await copyToClipboard('x', 'Link copied');

    expect(toast).not.toHaveBeenCalledWith({ description: 'Link copied' });
  });

  /**
   * `navigator.clipboard.writeText` additionally requires the *document to be focused*, and
   * rejects with NotAllowedError when it is not. Inside the desktop app that is an ordinary
   * state — DevTools focused, or the click that arrives while the window is being focused —
   * so "Copy diagnostic report" reported that the browser had blocked a copy nothing was
   * blocking. Electron's own clipboard has no focus requirement, so the shell is preferred
   * wherever it exists.
   */
  describe('inside the desktop app', () => {
    afterEach(() => {
      delete (window as unknown as { desktop?: unknown }).desktop;
    });

    function setDesktopClipboard(writeText: ReturnType<typeof vi.fn>) {
      (window as unknown as { desktop?: unknown }).desktop = { clipboard: { writeText } };
    }

    it('copies through the shell, so a page without focus still succeeds', async () => {
      // The web API is present and would reject exactly as an unfocused document makes it.
      const webWrite = vi
        .fn()
        .mockRejectedValue(
          Object.assign(new Error('Document is not focused'), { name: 'NotAllowedError' }),
        );
      setClipboard({ writeText: webWrite });
      const shellWrite = vi.fn().mockResolvedValue({ success: true });
      setDesktopClipboard(shellWrite);

      const ok = await copyToClipboard('report', 'Diagnostic report copied');

      expect(ok).toBe(true);
      expect(shellWrite).toHaveBeenCalledWith('report');
      // The failing web path must not even be attempted, or it would toast over the success.
      expect(webWrite).not.toHaveBeenCalled();
      expect(toast).toHaveBeenCalledWith({ description: 'Diagnostic report copied' });
    });

    it('falls back to the web API if the shell bridge fails', async () => {
      // The bridge existing does not prove the main process answered.
      setDesktopClipboard(vi.fn().mockRejectedValue(new Error('ipc gone')));
      const webWrite = vi.fn().mockResolvedValue(undefined);
      setClipboard({ writeText: webWrite });

      const ok = await copyToClipboard('x', 'Link copied');

      expect(ok).toBe(true);
      expect(webWrite).toHaveBeenCalledWith('x');
    });
  });
});
