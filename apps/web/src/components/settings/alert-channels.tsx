'use client';

import { useEffect, useState } from 'react';
import {
  addNotificationChannel,
  getNotificationChannels,
  removeNotificationChannel,
  testNotificationChannel,
  updateNotificationChannel,
  type NotificationChannel,
} from '@projekt-manga/api-client';
import { ActionButton, LoadingBlock, ToggleSwitch } from '@/components/settings/field-controls';
import { formatRelative } from '@/lib/manga-data';

type Kind = NotificationChannel['kind'];

const KINDS: Array<{ kind: Kind; label: string; help: string }> = [
  {
    kind: 'ntfy',
    label: 'ntfy',
    help: 'The topic URL, e.g. https://ntfy.sh/your-secret-topic, and a token if the topic is protected.',
  },
  {
    kind: 'discord',
    label: 'Discord',
    help: 'A channel webhook URL (Channel settings › Integrations › Webhooks).',
  },
  {
    kind: 'telegram',
    label: 'Telegram',
    help: 'Your bot token from @BotFather and the chat id (or @channel) the bot posts in.',
  },
  {
    kind: 'webhook',
    label: 'Webhook',
    help: 'Any URL: it receives a JSON POST with the titles and counts.',
  },
];

const INPUT =
  'w-full rounded-lg border border-border/60 bg-background px-3 py-1.5 text-sm text-foreground outline-none focus:border-primary/60';

const errorText = (error: unknown, fallback: string) =>
  error instanceof Error && error.message ? error.message : fallback;

/**
 * Settings › Notifications › Outside the app: where new-chapter alerts go when a scheduled
 * update finds chapters. The server keeps each destination encrypted and only ever shows
 * its host back.
 */
export function AlertChannels() {
  const [channels, setChannels] = useState<NotificationChannel[] | null>(null);
  const [unavailable, setUnavailable] = useState(false);
  const [adding, setAdding] = useState(false);
  const [kind, setKind] = useState<Kind>('ntfy');
  const [name, setName] = useState('');
  const [url, setUrl] = useState('');
  const [token, setToken] = useState('');
  const [chatId, setChatId] = useState('');
  const [busy, setBusy] = useState<string | null>(null);
  const [message, setMessage] = useState('');

  useEffect(() => {
    const controller = new AbortController();
    getNotificationChannels(controller.signal)
      .then((found) => setChannels(Array.isArray(found) ? found : []))
      // An aborted request (this effect cleaned up, as Strict Mode does on mount) says
      // nothing about the server; only a real failure means alerts are unavailable.
      .catch(() => {
        if (!controller.signal.aborted) setUnavailable(true);
      });
    return () => controller.abort();
  }, []);

  if (unavailable)
    return (
      <p className="text-xs text-muted-foreground">
        Alerts outside the app need a server that supports them.
      </p>
    );
  if (!channels) return <LoadingBlock label="Loading alert channels" />;

  const replace = (next: NotificationChannel) =>
    setChannels((current) => current?.map((c) => (c.id === next.id ? next : c)) ?? null);

  const act = async (id: string, work: () => Promise<void>) => {
    setBusy(id);
    setMessage('');
    try {
      await work();
    } catch (error) {
      setMessage(errorText(error, "Couldn't save that change."));
    } finally {
      setBusy(null);
    }
  };

  const add = () =>
    act('add', async () => {
      const label = name.trim() || KINDS.find((k) => k.kind === kind)!.label;
      const created = await addNotificationChannel(
        kind === 'telegram'
          ? { kind, name: label, token: token.trim(), chat_id: chatId.trim() }
          : kind === 'ntfy'
            ? { kind, name: label, url: url.trim(), ...(token.trim() && { token: token.trim() }) }
            : { kind, name: label, url: url.trim() },
      );
      setChannels((current) => [...(current ?? []), created]);
      setAdding(false);
      setName('');
      setUrl('');
      setToken('');
      setChatId('');
    });

  return (
    <div className="space-y-3">
      <p className="text-xs text-muted-foreground">
        When a scheduled update finds new chapters, one message goes to each channel here, following
        your muted sources, muted categories and quiet hours.
      </p>
      {channels.length > 0 && (
        <ul className="divide-y divide-border/50 rounded-xl border border-border/60">
          {channels.map((channel) => (
            <li key={channel.id} className="flex flex-wrap items-center gap-3 p-3">
              <div className="min-w-0 flex-1">
                <p className="truncate text-sm font-medium">{channel.name}</p>
                <p className="truncate text-xs text-muted-foreground">
                  {KINDS.find((k) => k.kind === channel.kind)?.label} · {channel.destination}
                  {channel.last_error
                    ? ` · Last try failed: ${channel.last_error}`
                    : channel.last_sent_at
                      ? ` · Last sent ${formatRelative(channel.last_sent_at)}`
                      : ''}
                </p>
              </div>
              <ToggleSwitch
                on={channel.enabled}
                disabled={busy === channel.id}
                label={`Send alerts to ${channel.name}`}
                onToggle={() =>
                  void act(channel.id, async () =>
                    replace(
                      await updateNotificationChannel(channel.id, { enabled: !channel.enabled }),
                    ),
                  )
                }
              />
              <ActionButton
                disabled={busy === channel.id}
                onClick={() =>
                  void act(channel.id, async () =>
                    replace(await testNotificationChannel(channel.id)),
                  )
                }
              >
                Send test
              </ActionButton>
              <ActionButton
                variant="destructive"
                disabled={busy === channel.id}
                onClick={() =>
                  void act(channel.id, async () => {
                    await removeNotificationChannel(channel.id);
                    setChannels((current) => current?.filter((c) => c.id !== channel.id) ?? null);
                  })
                }
              >
                Remove
              </ActionButton>
            </li>
          ))}
        </ul>
      )}
      {adding ? (
        <form
          aria-label="Add an alert channel"
          className="space-y-2 rounded-xl border border-border/60 bg-background/40 p-4"
          onSubmit={(event) => {
            event.preventDefault();
            void add();
          }}
        >
          <div className="flex flex-wrap gap-2" role="radiogroup" aria-label="Service">
            {KINDS.map((option) => (
              <button
                key={option.kind}
                type="button"
                role="radio"
                aria-checked={kind === option.kind}
                onClick={() => setKind(option.kind)}
                className={`rounded-full border px-3 py-1 text-xs ${
                  kind === option.kind
                    ? 'border-primary/60 bg-primary/10 text-primary'
                    : 'border-border/60 text-muted-foreground'
                }`}
              >
                {option.label}
              </button>
            ))}
          </div>
          <p className="text-xs text-muted-foreground">
            {KINDS.find((k) => k.kind === kind)?.help}
          </p>
          <input
            aria-label="Name"
            placeholder="Name (optional)"
            maxLength={60}
            value={name}
            onChange={(event) => setName(event.target.value)}
            className={INPUT}
          />
          {kind !== 'telegram' && (
            <input
              aria-label="URL"
              placeholder={kind === 'discord' ? 'https://discord.com/api/webhooks/…' : 'https://…'}
              type="url"
              required
              value={url}
              onChange={(event) => setUrl(event.target.value)}
              className={INPUT}
            />
          )}
          {(kind === 'ntfy' || kind === 'telegram') && (
            <input
              aria-label={kind === 'telegram' ? 'Bot token' : 'Access token (optional)'}
              placeholder={kind === 'telegram' ? 'Bot token' : 'Access token (optional)'}
              type="password"
              autoComplete="off"
              required={kind === 'telegram'}
              value={token}
              onChange={(event) => setToken(event.target.value)}
              className={INPUT}
            />
          )}
          {kind === 'telegram' && (
            <input
              aria-label="Chat id"
              placeholder="Chat id or @channel"
              required
              value={chatId}
              onChange={(event) => setChatId(event.target.value)}
              className={INPUT}
            />
          )}
          <div className="flex justify-end gap-2">
            <ActionButton onClick={() => setAdding(false)}>Cancel</ActionButton>
            <button
              type="submit"
              disabled={busy === 'add'}
              className="rounded-lg bg-primary px-3 py-1.5 text-xs font-medium text-primary-foreground disabled:opacity-50"
            >
              Add channel
            </button>
          </div>
        </form>
      ) : (
        <div>
          <ActionButton onClick={() => setAdding(true)}>Add a channel</ActionButton>
        </div>
      )}
      {message && (
        <p role="alert" className="text-xs text-destructive">
          {message}
        </p>
      )}
    </div>
  );
}
