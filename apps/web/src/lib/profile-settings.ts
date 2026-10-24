import type { SettingValue } from './app-store';

function prefix(owner: string) {
  return `profile:${encodeURIComponent(owner)}:`;
}

export function profileSettingsForExport(settings: Record<string, SettingValue>, owner: string) {
  return Object.fromEntries(
    Object.entries(settings).filter(
      ([key]) => !key.startsWith('profile:') || key.startsWith(prefix(owner)),
    ),
  );
}

export function profileSettingsForImport(
  settings: Record<string, SettingValue>,
  owner: string,
  exportedOwner?: string,
) {
  const sourcePrefix = prefix(exportedOwner ?? owner);
  const targetPrefix = prefix(owner);
  return Object.fromEntries(
    Object.entries(settings)
      .filter(([key]) => !key.startsWith('profile:') || key.startsWith(sourcePrefix))
      .map(([key, value]) => [
        key.startsWith(sourcePrefix) ? `${targetPrefix}${key.slice(sourcePrefix.length)}` : key,
        value,
      ]),
  );
}

export function replaceProfileSettings(
  current: Record<string, SettingValue>,
  imported: Record<string, SettingValue>,
  owner: string,
) {
  const retained = Object.fromEntries(
    Object.entries(current).filter(
      ([key]) => key.startsWith('profile:') && !key.startsWith(prefix(owner)),
    ),
  );
  return { ...retained, ...profileSettingsForImport(imported, owner) };
}
