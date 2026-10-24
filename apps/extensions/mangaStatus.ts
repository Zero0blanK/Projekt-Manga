// Plain-string status vocabulary so sources never need a database-generated enum type.
// Local to apps/extensions: the server only stores whatever string a source returns.
export const MANGA_STATUS = {
  ONGOING: 'ONGOING',
  COMPLETED: 'COMPLETED',
  HIATUS: 'HIATUS',
  CANCELLED: 'CANCELLED',
  UNKNOWN: 'UNKNOWN',
} as const;
