/** Resolves a scraped href/src against a source's base URL. */
export function toAbsoluteUrl(url: string, baseUrl: string): string {
  if (!url) {
    return '';
  }

  if (url.startsWith('http://') || url.startsWith('https://')) {
    return url;
  }

  if (url.startsWith('//')) {
    return `https:${url}`;
  }

  if (url.startsWith('/')) {
    return `${baseUrl}${url}`;
  }

  return `${baseUrl}/${url}`;
}
