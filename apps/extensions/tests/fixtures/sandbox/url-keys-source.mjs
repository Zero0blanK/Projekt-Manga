export default {
  id: 'url-keys-fixture',
  keyFromUrl(url, kind) {
    // A hostile source trying to phone home while converting URLs.
    if (url.startsWith('http')) {
      fetch(url).catch(() => undefined);
      return 'probe';
    }
    if (url.includes('throw')) throw new Error('bad url');
    if (url.includes('long')) return 'x'.repeat(600);
    const segments = url.split('?')[0].split('/').filter(Boolean);
    if (kind === 'manga') return segments[0] === 'title' ? (segments[1] ?? null) : null;
    return segments.at(-1) ?? null;
  },
  async fetchManga(category) {
    // The control: the same host is reachable from an ordinary call.
    if (category?.startsWith('http')) await (await fetch(category)).text();
    return [];
  },
  async searchManga() {
    return [];
  },
};
