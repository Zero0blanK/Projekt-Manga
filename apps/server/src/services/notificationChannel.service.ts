/**
 * New-chapter alerts outside the app: ntfy, Discord, Telegram and plain webhooks.
 *
 * A destination (its URL and any token) is encrypted at rest with the same key as tracker
 * tokens, never returned by the API and never written to a log or to `last_error`. Sends go
 * through guardedFetch, so like source requests they only reach public addresses, unless
 * the server's owner sets ALERTS_ALLOW_PRIVATE_HOSTS=true for a self-hosted receiver.
 */
import notificationChannelRepository from '../repositories/notificationChannel.repository.js';
import type {
  ChapterAlertBody,
  CreateNotificationChannelBody,
  NotificationChannelKind,
  UpdateNotificationChannelBody,
} from '@projekt-manga/schemas';
import { decryptToken, encryptToken } from '../utils/tokenCrypto.js';
import { guardedFetch } from '../utils/guardedFetch.js';
import { UnsafeUrlError, assertPublicHttpUrl } from '../utils/ssrfGuard.js';
import { NotFoundError, ValidationError } from '../utils/customErrors.js';

const MAX_CHANNELS = 10;
const SEND_TIMEOUT_MS = 10_000;
/** At most one alert per identity in this window: a library update sends one at its end. */
const ALERT_INTERVAL_MS = 30_000;
/** Titles named in a message before "and N more". */
const LISTED_TITLES = 10;

type Target = { url?: string; token?: string; chat_id?: string };

export interface ChannelSummary {
  id: string;
  kind: NotificationChannelKind;
  name: string;
  enabled: boolean;
  /** Where it goes, without anything secret: the host, or "Telegram". */
  destination: string;
  last_sent_at: Date | null;
  last_error: string | null;
}

function destinationOf(kind: string, target: Target): string {
  if (kind === 'telegram') return 'Telegram';
  try {
    return new URL(target.url ?? '').host;
  } catch {
    return kind;
  }
}

function summarize(row: {
  id: string;
  kind: string;
  name: string;
  enabled: boolean;
  target_encrypted: string;
  last_sent_at: Date | null;
  last_error: string | null;
}): ChannelSummary {
  let destination: string;
  try {
    destination = destinationOf(row.kind, JSON.parse(decryptToken(row.target_encrypted)));
  } catch {
    destination = 'Unreadable: re-add this channel';
  }
  return {
    id: row.id,
    kind: row.kind as NotificationChannelKind,
    name: row.name,
    enabled: row.enabled,
    destination,
    last_sent_at: row.last_sent_at,
    last_error: row.last_error,
  };
}

const list = async (user_id: string | null) =>
  (await notificationChannelRepository.list(user_id)).map(summarize);

const create = async (body: CreateNotificationChannelBody, user_id: string | null) => {
  if ((await notificationChannelRepository.countFor(user_id)) >= MAX_CHANNELS)
    throw new ValidationError(`At most ${MAX_CHANNELS} alert channels`);
  const target: Target =
    body.kind === 'telegram'
      ? { token: body.token, chat_id: body.chat_id }
      : body.kind === 'ntfy'
        ? { url: body.url, ...(body.token && { token: body.token }) }
        : { url: body.url };
  const row = await notificationChannelRepository.create({
    user_id,
    kind: body.kind,
    name: body.name,
    target_encrypted: encryptToken(JSON.stringify(target)),
  });
  return summarize(row);
};

const ownRow = async (id: string, user_id: string | null) => {
  const row = await notificationChannelRepository.findOwned(id, user_id);
  if (!row) throw new NotFoundError('Alert channel not found');
  return row;
};

const update = async (id: string, body: UpdateNotificationChannelBody, user_id: string | null) => {
  await ownRow(id, user_id);
  return summarize(await notificationChannelRepository.update(id, body));
};

const remove = async (id: string, user_id: string | null) => {
  await ownRow(id, user_id);
  await notificationChannelRepository.remove(id);
};

/** The message, from what an update found. Plain text: every service shows it as-is. */
export function alertText(titles: ChapterAlertBody['titles']): { title: string; body: string } {
  const total = titles.reduce((sum, entry) => sum + entry.count, 0);
  const lines = titles
    .slice(0, LISTED_TITLES)
    .map((entry) => `• ${entry.title}: ${entry.count} new`);
  if (titles.length > LISTED_TITLES) lines.push(`and ${titles.length - LISTED_TITLES} more titles`);
  return {
    title: `${total} new chapter${total === 1 ? '' : 's'}`,
    body: lines.join('\n'),
  };
}

/** The HTTP request a channel kind makes for a message. Pure, for the tests. */
export function requestFor(
  kind: NotificationChannelKind,
  target: Target,
  message: { title: string; body: string },
  titles: ChapterAlertBody['titles'],
): { url: URL; init: RequestInit } {
  const json = (value: unknown): RequestInit => ({
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(value),
  });
  switch (kind) {
    case 'ntfy':
      return {
        url: new URL(target.url!),
        init: {
          method: 'POST',
          headers: {
            // Header values must be plain ASCII.
            Title: message.title.replace(/[^\x20-\x7e]/g, '?'),
            Tags: 'books',
            ...(target.token && { Authorization: `Bearer ${target.token}` }),
          },
          body: message.body,
        },
      };
    case 'discord':
      return {
        url: new URL(target.url!),
        init: json({
          content: `**${message.title}**\n${message.body}`.slice(0, 2000),
          allowed_mentions: { parse: [] },
        }),
      };
    case 'telegram':
      return {
        url: new URL(`https://api.telegram.org/bot${target.token}/sendMessage`),
        init: json({
          chat_id: target.chat_id,
          text: `${message.title}\n${message.body}`.slice(0, 4096),
          disable_web_page_preview: true,
        }),
      };
    default:
      return {
        url: new URL(target.url!),
        init: json({ event: 'new-chapters', ...message, titles }),
      };
  }
}

/** Sends with the address checks, or plain fetch when private destinations are allowed. */
async function deliver(url: URL, init: RequestInit): Promise<Response> {
  const signal = AbortSignal.timeout(SEND_TIMEOUT_MS);
  // Never follow a redirect: it could point anywhere, past the checks above.
  const options = { ...init, signal, redirect: 'error' as const };
  if (process.env.ALERTS_ALLOW_PRIVATE_HOSTS === 'true') return fetch(url, options);
  // The URL itself first (an IP literal never reaches a DNS lookup), then every address
  // the socket connects to.
  await assertPublicHttpUrl(url.href);
  return guardedFetch(url, options);
}

function refusedAddress(error: unknown): boolean {
  for (let cause = error, depth = 0; cause && depth < 5; depth++) {
    if (cause instanceof UnsafeUrlError) return true;
    cause = (cause as { cause?: unknown }).cause;
  }
  return false;
}

/** A failure as it is stored and shown: status or kind only, never the address or token. */
function safeError(error: unknown): string {
  if (error instanceof Error && error.name === 'TimeoutError') return 'Timed out';
  if (refusedAddress(error))
    return 'Refused: not a public address (see ALERTS_ALLOW_PRIVATE_HOSTS)';
  return "Couldn't connect";
}

async function sendTo(
  row: { id: string; kind: string; target_encrypted: string },
  titles: ChapterAlertBody['titles'],
): Promise<boolean> {
  let error: string | null = null;
  try {
    const target = JSON.parse(decryptToken(row.target_encrypted)) as Target;
    const { url, init } = requestFor(
      row.kind as NotificationChannelKind,
      target,
      alertText(titles),
      titles,
    );
    const response = await deliver(url, init);
    if (!response.ok) error = `HTTP ${response.status}`;
  } catch (cause) {
    error = safeError(cause);
  }
  await notificationChannelRepository.update(
    row.id,
    error ? { last_error: error } : { last_sent_at: new Date(), last_error: null },
  );
  return error === null;
}

const lastAlert = new Map<string, number>();

/** One update's findings to every enabled channel of this identity, at most once per
 * ALERT_INTERVAL_MS. Returns how many channels took it. */
const alert = async (body: ChapterAlertBody, user_id: string | null) => {
  const owner = user_id ?? 'anonymous';
  const now = Date.now();
  if (now - (lastAlert.get(owner) ?? 0) < ALERT_INTERVAL_MS) return { sent: 0, skipped: true };
  lastAlert.set(owner, now);
  const rows = await notificationChannelRepository.listEnabled(user_id);
  const results = await Promise.all(rows.map((row) => sendTo(row, body.titles)));
  return { sent: results.filter(Boolean).length, skipped: false };
};

/** "Send a test": a sample message to one channel, saving the outcome on it. */
const test = async (id: string, user_id: string | null) => {
  const row = await ownRow(id, user_id);
  await sendTo(row, [{ title: 'Projekt Manga test alert', count: 1 }]);
  return summarize(await ownRow(id, user_id));
};

/** For tests: forget the rate limit. */
export const resetAlertRateLimit = () => lastAlert.clear();

const notificationChannelService = { list, create, update, remove, alert, test };

export default notificationChannelService;
