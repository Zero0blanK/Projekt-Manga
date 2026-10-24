import { describe, expect, it } from 'vitest';
import {
  profileSettingsForExport,
  profileSettingsForImport,
  replaceProfileSettings,
} from '@/lib/profile-settings';

describe('profile settings backups', () => {
  const settings = {
    theme: 'dark',
    'profile:account-a:page-notes': 'private-a',
    'profile:account-b:page-notes': 'private-b',
  };
  it('exports the current profile and shared preferences only', () => {
    expect(profileSettingsForExport(settings, 'account-b')).toEqual({
      theme: 'dark',
      'profile:account-b:page-notes': 'private-b',
    });
  });
  it('imports the explicitly exported profile into the selected profile without other accounts', () => {
    expect(profileSettingsForImport(settings, 'anonymous', 'account-a')).toEqual({
      theme: 'dark',
      'profile:anonymous:page-notes': 'private-a',
    });
  });
  it('replaces current/shared preferences while preserving other account profiles', () => {
    expect(
      replaceProfileSettings(
        settings,
        { theme: 'light', 'profile:account-b:reading-queue': 'queue' },
        'account-b',
      ),
    ).toEqual({
      theme: 'light',
      'profile:account-a:page-notes': 'private-a',
      'profile:account-b:reading-queue': 'queue',
    });
  });
  it('ignores foreign profile values from older exports without ownership metadata', () => {
    expect(profileSettingsForImport(settings, 'anonymous')).toEqual({ theme: 'dark' });
  });
});
