/** Next preserves path delimiters in dynamic params; other characters are already decoded. */
export function decodeSourceRouteId(value: string): string {
  return value.replace(/%(?:25(?:2f|23|3f|5c)|2f|23|3f|5c)/gi, (encoded) =>
    decodeURIComponent(encoded),
  );
}
