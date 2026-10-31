import { z } from 'zod';

/** Where new-chapter alerts can go outside the app. */
export const notificationChannelKinds = ['ntfy', 'discord', 'telegram', 'webhook'] as const;
export const notificationChannelKindSchema = z.enum(notificationChannelKinds);
export type NotificationChannelKind = z.infer<typeof notificationChannelKindSchema>;

const httpsUrl = z
  .string()
  .trim()
  .max(2048)
  .url()
  .refine((value) => /^https?:\/\//i.test(value), 'Must be an http(s) address');

/**
 * A new channel. What each kind needs:
 * - ntfy: the topic URL (https://ntfy.sh/your-topic or a self-hosted server), and an access
 *   token when the topic is protected.
 * - discord: a channel webhook URL.
 * - telegram: a bot token and the chat id to post in.
 * - webhook: any URL, which receives a JSON POST.
 */
export const createNotificationChannelBodySchema = z
  .discriminatedUnion('kind', [
    z.object({
      kind: z.literal('ntfy'),
      name: z.string().trim().min(1).max(60),
      url: httpsUrl,
      token: z.string().trim().max(256).optional(),
    }),
    z.object({
      kind: z.literal('discord'),
      name: z.string().trim().min(1).max(60),
      url: httpsUrl.refine(
        (value) =>
          /^https:\/\/(?:(?:ptb|canary)\.)?discord(?:app)?\.com\/api\/webhooks\//i.test(value),
        'Must be a Discord webhook URL',
      ),
    }),
    z.object({
      kind: z.literal('telegram'),
      name: z.string().trim().min(1).max(60),
      token: z
        .string()
        .trim()
        .regex(/^\d{4,20}:[A-Za-z0-9_-]{20,100}$/, 'Must be a Telegram bot token'),
      chat_id: z
        .string()
        .trim()
        .regex(/^-?\d{1,20}$|^@[A-Za-z0-9_]{4,64}$/, 'Must be a chat id or @channel'),
    }),
    z.object({
      kind: z.literal('webhook'),
      name: z.string().trim().min(1).max(60),
      url: httpsUrl,
    }),
  ])
  .superRefine((body, ctx) => {
    if ('url' in body && /\/\/[^/]*@/.test(body.url))
      ctx.addIssue({
        code: 'custom',
        path: ['url'],
        message: 'Put credentials in the token field',
      });
  });
export type CreateNotificationChannelBody = z.infer<typeof createNotificationChannelBodySchema>;

export const updateNotificationChannelBodySchema = z
  .object({
    name: z.string().trim().min(1).max(60).optional(),
    enabled: z.boolean().optional(),
  })
  .strict()
  .refine((body) => body.name !== undefined || body.enabled !== undefined, {
    message: 'Nothing to change',
  });
export type UpdateNotificationChannelBody = z.infer<typeof updateNotificationChannelBodySchema>;

/** What one library update found, sent once at the end of the run. */
export const chapterAlertBodySchema = z
  .object({
    titles: z
      .array(
        z.object({
          title: z.string().trim().min(1).max(200),
          count: z.number().int().min(1).max(10_000),
        }),
      )
      .min(1)
      .max(200),
  })
  .strict();
export type ChapterAlertBody = z.infer<typeof chapterAlertBodySchema>;
