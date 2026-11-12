/**
 * Which installed extension stands behind a source id.
 *
 * A source is known to the app by its `source_key`, but installed rows are unique on
 * (repository, key), so two rows can carry one key. The server loads only one of them (the
 * first-installed enabled row; see sandboxedSourceRegistry.service.ts). Every lookup of
 * "the row for this source", on the server or in the UI, goes through here so they all
 * name that same row. With none enabled, the first-installed row still describes the
 * source: titles already stored from it keep their site, rating and repository.
 */

interface KeyedExtension {
  source_key: string;
  enabled?: boolean | null;
}

/** The installed row that stands behind `sourceKey`, or undefined when none is installed.
 * `rows` in installed order, as the API lists them. */
export function installedExtensionFor<Row extends KeyedExtension>(
  rows: readonly Row[],
  sourceKey: string,
): Row | undefined {
  let first: Row | undefined;
  for (const row of rows) {
    if (row.source_key !== sourceKey) continue;
    if (row.enabled) return row;
    first ??= row;
  }
  return first;
}

/** `installedExtensionFor` for every key at once. */
export function installedExtensionsByKey<Row extends KeyedExtension>(
  rows: readonly Row[],
): Map<string, Row> {
  const byKey = new Map<string, Row>();
  for (const row of rows) {
    const held = byKey.get(row.source_key);
    if (!held || (!held.enabled && row.enabled)) byKey.set(row.source_key, row);
  }
  return byKey;
}
