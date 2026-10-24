export function requireSecureAccountTransport(apiBaseUrl: string): void {
  const { protocol, hostname } = new URL(apiBaseUrl);
  const isLoopback = hostname === 'localhost' || hostname === '127.0.0.1' || hostname === '[::1]';
  if (protocol !== 'https:' && !(protocol === 'http:' && isLoopback)) {
    throw new Error('Account data requires HTTPS for a remote server');
  }
}
