// An "installed extension" that reports everything it can observe about cookies, used by
// tests/sandbox.test.ts to prove the parent's browser session never reaches the child.
import fs from 'node:fs';

function readConfig() {
  return JSON.parse(fs.readFileSync(new URL('./test-config.json', import.meta.url), 'utf-8'));
}

export default {
  id: 'cookie-probe-source',
  name: 'Cookie Probe Source',
  lang: 'en',
  base_url: 'https://example.invalid',
  isNSFW: false,

  /** Fetches each configured URL and returns what the response exposed to this process. */
  async fetchManga() {
    const results = [];
    for (const url of readConfig().urls) {
      try {
        const res = await fetch(url, { headers: { 'User-Agent': 'probe-ua', Cookie: 'own=1' } });
        results.push({
          url,
          status: res.status,
          headerNames: [...res.headers.keys()],
          setCookie: res.headers.get('set-cookie'),
          body: await res.text(),
        });
      } catch (error) {
        results.push({ url, error: error.message });
      }
    }
    return results;
  },
  async searchManga() {
    return [];
  },
  /** Treats a challenge page like most scrapers do: as an unexpected response. */
  async fetchChapters() {
    const res = await fetch(readConfig().challengeUrl);
    if (!res.ok) throw new Error(`Unexpected status ${res.status}`);
    return [];
  },
  /** Fails on its own, after a while and without fetching anything: a title that's gone. */
  async fetchChapterPages() {
    await new Promise((resolve) => setTimeout(resolve, readConfig().failAfterMs ?? 0));
    throw new Error('Chapter is gone');
  },
  async getFilters() {
    return [];
  },
};
