import { MANGA_STATUS } from '../mangaStatus.js';

/** Fuzzy-matches a scraped status string against MANGA_STATUS. Shared by every source
 * that scrapes a free-text status label. */
export function mapMangaStatus(raw: string): string {
  const normalized = raw.trim().toLowerCase();

  if (normalized.includes('ongoing')) {
    return MANGA_STATUS.ONGOING;
  }
  if (normalized.includes('complete') || normalized.includes('completed')) {
    return MANGA_STATUS.COMPLETED;
  }
  if (normalized.includes('hiatus')) {
    return MANGA_STATUS.HIATUS;
  }
  if (normalized.includes('cancel')) {
    return MANGA_STATUS.CANCELLED;
  }

  return MANGA_STATUS.UNKNOWN;
}

function parseRelativeDateToIso(raw: string): string {
  const text = raw.replace(/\u00A0/g, ' ').toLowerCase();
  const matches = [...text.matchAll(/(\d+)\s*(year|month|week|day|hour|minute|second)s?/g)];
  if (matches.length === 0) {
    return '';
  }

  const now = Date.now();
  let deltaMs = 0;

  for (const match of matches) {
    const amount = Number.parseInt(match[1], 10);
    const unit = match[2];

    if (!Number.isFinite(amount) || amount <= 0) {
      continue;
    }

    switch (unit) {
      case 'year':
        deltaMs += amount * 365 * 24 * 60 * 60 * 1000;
        break;
      case 'month':
        deltaMs += amount * 30 * 24 * 60 * 60 * 1000;
        break;
      case 'week':
        deltaMs += amount * 7 * 24 * 60 * 60 * 1000;
        break;
      case 'day':
        deltaMs += amount * 24 * 60 * 60 * 1000;
        break;
      case 'hour':
        deltaMs += amount * 60 * 60 * 1000;
        break;
      case 'minute':
        deltaMs += amount * 60 * 1000;
        break;
      case 'second':
        deltaMs += amount * 1000;
        break;
      default:
        break;
    }
  }

  if (deltaMs <= 0) {
    return '';
  }

  return new Date(now - deltaMs).toISOString();
}

/** Parses either an absolute date string or a relative one ("3 days ago") into ISO-8601.
 * Shared by every source that scrapes a free-text release date. */
export function parseDateToIso(raw: string): string {
  if (!raw) {
    return '';
  }

  const cleaned = raw
    .replace(/\u00A0/g, ' ')
    .replace(/\b(Jan|Feb|Mar|Apr|Jun|Jul|Aug|Sep|Sept|Oct|Nov|Dec)\./gi, '$1')
    .replace(/\ba\.m\./i, 'AM')
    .replace(/\bp\.m\./i, 'PM')
    .trim();

  const parsed = new Date(cleaned);
  if (!Number.isNaN(parsed.getTime())) {
    return parsed.toISOString();
  }

  return parseRelativeDateToIso(cleaned);
}
