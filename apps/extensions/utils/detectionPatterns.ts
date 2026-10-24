/**
 * Single source of truth for "does this response body look like a bot-block". Deliberately
 * has zero imports: sourceError.ts pulls it in and must stay dependency-free because every
 * source imports it.
 */
export const BAN_PATTERNS: RegExp[] = [
  /access\s*denied/i,
  /forbidden/i,
  /blocked/i,
  /banned/i,
  /rate\s*limit/i,
  /too\s*many\s*requests/i,
  /ip\s*blocked/i,
  /your\s*ip\s*has\s*been\s*banned/i,
  /please\s*try\s*again\s*later/i,
  /temporarily\s*unavailable/i,
];

export const CLOUDFLARE_PATTERNS: RegExp[] = [
  /cf-browser-verification/i,
  /cf-challenge/i,
  /just\s*a\s*moment/i,
  /checking\s*your\s*browser/i,
  /you\s*are\s*being\s*redirected/i,
  /ddos-guard/i,
  /__cf_chl_/i,
];

export const CAPTCHA_PATTERNS: RegExp[] = [
  /recaptcha/i,
  /hcaptcha/i,
  /captcha/i,
  /g-recaptcha/i,
  /h-captcha/i,
  /verify\s*you\s*are\s*human/i,
  /prove\s*you\s*are\s*not\s*a\s*robot/i,
];

export function matchesAny(patterns: RegExp[], html: string): boolean {
  return patterns.some((pattern) => pattern.test(html));
}
