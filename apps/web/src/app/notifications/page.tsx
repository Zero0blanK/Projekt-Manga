import type { Metadata } from 'next';
import { NotificationsPageClient } from './client';

export const metadata: Metadata = {
  title: 'Notifications — Projekt Manga',
  description: 'New chapters for series in your library, plus the extension update log.',
  openGraph: {
    title: 'Notifications — Projekt Manga',
    description: 'New chapters for series in your library.',
  },
};

export default function NotificationsPage() {
  return <NotificationsPageClient />;
}
