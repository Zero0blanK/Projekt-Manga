import type { Metadata } from 'next';
import { SettingsPageClient } from './client';

export const metadata: Metadata = {
  title: 'Settings — Projekt Manga',
  description: 'Customize your reading experience, theme, notifications, and sync preferences.',
  openGraph: {
    title: 'Settings — Projekt Manga',
    description: 'Customize Projekt Manga to your taste.',
  },
};

export default function SettingsPage() {
  return <SettingsPageClient />;
}
