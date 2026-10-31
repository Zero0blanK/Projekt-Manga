/** Operator settings for requests installed sources make through the sandbox. They change
 * how a request goes out, never which hosts a source may reach. */
export interface SourceNetworkConfig {
  /** Sent instead of the User-Agent a source sets; null leaves the source's own. */
  userAgent: string | null;
  /** DNS over HTTPS resolver (JSON API) used instead of system DNS; null uses system DNS. */
  dohUrl: string | null;
}
