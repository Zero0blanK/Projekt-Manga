/**
 * Pure helpers for local comics: natural page order, ComicInfo.xml and EPUB reading
 * order. No Electron or file access here, so the parsing of untrusted file contents can
 * be tested on its own.
 */
import path from 'node:path';

export const IMAGE_EXTENSIONS = ['.jpg', '.jpeg', '.png', '.webp'] as const;
export const isImageName = (name: string) =>
  (IMAGE_EXTENSIONS as readonly string[]).includes(path.posix.extname(name).toLowerCase());

/** "2.png" before "10.png", the way a person numbers pages. */
export function naturalCompare(a: string, b: string): number {
  return a.localeCompare(b, 'en', { numeric: true }) || a.localeCompare(b);
}

/** What a ComicInfo.xml says about a comic. Every field is optional and length-capped. */
export interface ComicInfo {
  series?: string;
  number?: string;
  title?: string;
  writer?: string;
  summary?: string;
  genres?: string[];
}

export const COMIC_INFO_LIMIT = 64 * 1024;
const FIELD_LIMITS = { series: 200, number: 20, title: 200, writer: 200, summary: 4000 } as const;

function decodeEntities(text: string): string {
  return text
    .replace(/&#(\d{1,7});/g, (_, code: string) => safeCodePoint(Number(code)))
    .replace(/&#x([0-9a-f]{1,6});/gi, (_, code: string) => safeCodePoint(parseInt(code, 16)))
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, '&');
}

function safeCodePoint(code: number): string {
  // Control characters and invalid code points are dropped rather than decoded.
  if (!Number.isInteger(code) || code < 32 || code > 0x10ffff || (code >= 0xd800 && code <= 0xdfff))
    return '';
  return String.fromCodePoint(code);
}

function element(xml: string, tag: string, limit: number): string | undefined {
  const match = new RegExp(`<${tag}(?:\\s[^>]*)?>([^<]*)</${tag}>`, 'i').exec(xml);
  if (!match) return undefined;
  const value = decodeEntities(match[1]).replace(/\s+/g, ' ').trim();
  return value ? value.slice(0, limit) : undefined;
}

/**
 * Reads the handful of ComicInfo fields the app shows. A plain scan for simple elements
 * rather than an XML parser: nothing is resolved, so a DOCTYPE or entity declaration can't
 * pull in other files or expand into a "billion laughs", and such a file is refused
 * outright. Returns null when the file is unusable or says nothing.
 */
export function parseComicInfo(xml: string): ComicInfo | null {
  if (xml.length > COMIC_INFO_LIMIT || /<!(?:DOCTYPE|ENTITY)/i.test(xml)) return null;
  if (!/<ComicInfo[\s>]/i.test(xml)) return null;
  const info: ComicInfo = {};
  for (const [key, limit] of Object.entries(FIELD_LIMITS) as [
    keyof typeof FIELD_LIMITS,
    number,
  ][]) {
    const value = element(xml, key, limit);
    if (value) info[key] = value;
  }
  const genres = element(xml, 'Genre', 500)
    ?.split(/[,;]/)
    .map((genre) => genre.trim())
    .filter(Boolean)
    .slice(0, 20);
  if (genres?.length) info.genres = genres;
  return Object.keys(info).length ? info : null;
}

/** The name a comic is listed under: "Series #12 · Title" from its ComicInfo, else the
 * file or folder name. */
export function comicDisplayTitle(info: ComicInfo | null | undefined, fallback: string): string {
  const series = info?.series;
  const parts = [
    series ? `${series}${info?.number ? ` #${info.number}` : ''}` : undefined,
    info?.title && info.title !== series ? info.title : undefined,
  ].filter(Boolean);
  return (parts.length ? parts.join(' · ') : fallback).slice(0, 200);
}

/** Resolves an href inside an EPUB against the file it appears in, or null when it points
 * outside the archive (an absolute URL, a path climbing above the root). */
function resolveEpubHref(from: string, href: string): string | null {
  if (/^[a-z][a-z0-9+.-]*:/i.test(href) || href.startsWith('/')) return null;
  let decoded: string;
  try {
    decoded = decodeURIComponent(href.split('#')[0]);
  } catch {
    return null;
  }
  const joined = path.posix.normalize(path.posix.join(path.posix.dirname(from), decoded));
  return joined.startsWith('../') || joined === '..' ? null : joined;
}

const attribute = (tag: string, name: string) =>
  new RegExp(`\\s${name}\\s*=\\s*["']([^"']*)["']`, 'i').exec(tag)?.[1];

/**
 * An EPUB's page images in reading order: the spine's documents in order, and within each
 * the images it shows, each image once at its first appearance. Images the spine never
 * shows (a stray cover copy, say) follow in natural order, so nothing is silently lost.
 *
 * `documents` holds the text of the OPF and of the spine's (X)HTML files, keyed by their
 * path in the archive.
 */
export function epubPageOrder(images: readonly string[], documents: ReadonlyMap<string, string>) {
  const available = new Set(images);
  const ordered: string[] = [];
  // A set beside the list keeps each add constant-time: an archive is untrusted, and one
  // with thousands of images (or references) mustn't stall the main process.
  const added = new Set<string>();
  const add = (name: string | null) => {
    if (!name || !available.has(name) || added.has(name)) return;
    added.add(name);
    ordered.push(name);
  };
  const opfPath = [...documents.keys()].find((name) => name.toLowerCase().endsWith('.opf'));
  const opf = opfPath ? documents.get(opfPath)! : '';
  if (opfPath) {
    const manifest = new Map<string, string>();
    for (const [tag] of opf.matchAll(/<item\s[^>]*>/gi)) {
      const id = attribute(tag, 'id');
      const href = attribute(tag, 'href');
      const resolved = href ? resolveEpubHref(opfPath, href) : null;
      if (id && resolved) manifest.set(id, resolved);
    }
    for (const [tag] of opf.matchAll(/<itemref\s[^>]*>/gi)) {
      const doc = manifest.get(attribute(tag, 'idref') ?? '');
      if (!doc) continue;
      if (isImageName(doc)) {
        add(doc);
        continue;
      }
      const text = documents.get(doc);
      if (!text) continue;
      for (const [, href] of text.matchAll(/\s(?:src|xlink:href|href)\s*=\s*["']([^"']+)["']/gi))
        if (isImageName(href)) add(resolveEpubHref(doc, href));
    }
  }
  for (const name of [...images].sort(naturalCompare)) add(name);
  return ordered;
}
