const TIME = /^(?:[01]\d|2[0-3]):[0-5]\d$/;

/** True only for a valid quiet-hours interval; equal endpoints mean quiet hours are off. */
export function isQuietHours(now: Date, start: string, end: string): boolean {
  if (!TIME.test(start) || !TIME.test(end) || start === end) return false;
  const minutes = now.getHours() * 60 + now.getMinutes();
  const [startHour, startMinute] = start.split(':').map(Number);
  const [endHour, endMinute] = end.split(':').map(Number);
  const startMinutes = startHour * 60 + startMinute;
  const endMinutes = endHour * 60 + endMinute;
  return startMinutes < endMinutes
    ? minutes >= startMinutes && minutes < endMinutes
    : minutes >= startMinutes || minutes < endMinutes;
}
