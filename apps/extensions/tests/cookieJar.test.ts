import { describe, it, expect } from 'vitest';
import {
  CookieJar,
  parseSetCookie,
  isCloudflareChallenge,
  isPublicSuffix,
} from '../sandbox/cookieJar.js';

const site = new URL('https://www.example.com/manga/one');

describe('parseSetCookie', () => {
  it('reads attributes, defaulting to a host-only cookie on the default path', () => {
    expect(parseSetCookie('a=1', site)).toMatchObject({
      name: 'a',
      value: '1',
      domain: 'www.example.com',
      hostOnly: true,
      path: '/manga',
      secure: false,
    });
    expect(
      parseSetCookie('cf_clearance=x; Domain=.example.com; Path=/; Secure; HttpOnly', site),
    ).toMatchObject({
      domain: 'example.com',
      hostOnly: false,
      path: '/',
      secure: true,
      httpOnly: true,
    });
  });

  it('refuses a Domain the responding host may not set', () => {
    expect(parseSetCookie('a=1; Domain=evil.test', site)).toBeNull();
    expect(parseSetCookie('a=1; Domain=other.example.com', site)).toBeNull();
    expect(parseSetCookie('novalue', site)).toBeNull();
  });

  it('refuses a Domain that is a public suffix, as a browser does', () => {
    // Two unrelated sites under co.uk must not share cookies.
    expect(parseSetCookie('a=1; Domain=co.uk', new URL('https://a.co.uk/'))).toBeNull();
    expect(parseSetCookie('a=1; Domain=uk', new URL('https://a.co.uk/'))).toBeNull();
    // Private suffixes too: every github.io site is someone else's.
    expect(parseSetCookie('a=1; Domain=github.io', new URL('https://me.github.io/'))).toBeNull();
    expect(parseSetCookie('a=1; Domain=a.co.uk', new URL('https://www.a.co.uk/'))).toMatchObject({
      domain: 'a.co.uk',
      hostOnly: false,
    });
    expect(isPublicSuffix('co.uk')).toBe(true);
    expect(isPublicSuffix('example.co.uk')).toBe(false);
  });
});

describe('CookieJar', () => {
  it('matches domain, path and Secure like a browser', () => {
    const jar = new CookieJar();
    jar.setCookies(site, [
      'domainwide=1; Domain=example.com; Path=/',
      'hostonly=2; Path=/',
      'deep=3; Path=/manga',
      'secure=4; Path=/; Secure',
    ]);

    expect(jar.cookieHeader(new URL('https://www.example.com/manga/two'))).toBe(
      'deep=3; domainwide=1; hostonly=2; secure=4',
    );
    expect(jar.cookieHeader(new URL('https://cdn.example.com/x'))).toBe('domainwide=1');
    expect(jar.cookieHeader(new URL('http://www.example.com/'))).toBe('domainwide=1; hostonly=2');
    expect(jar.cookieHeader(new URL('https://www.example.com/mangaX'))).not.toContain('deep');
    expect(jar.cookieHeader(new URL('https://example.org/'))).toBeUndefined();
  });

  it('replaces by name/domain/path, deletes on expiry and drops expired cookies', () => {
    const jar = new CookieJar();
    jar.setCookies(site, ['a=1; Path=/']);
    jar.setCookies(site, ['a=2; Path=/']);
    expect(jar.cookieHeader(site)).toBe('a=2');

    expect(jar.setCookies(site, ['a=gone; Path=/; Max-Age=0'])).toBe(true);
    expect(jar.cookieHeader(site)).toBeUndefined();

    const stale = new CookieJar([
      {
        name: 'old',
        value: 'x',
        domain: 'www.example.com',
        hostOnly: true,
        path: '/',
        secure: false,
        httpOnly: false,
        expires: 1,
      },
    ]);
    expect(stale.toJSON()).toEqual([]);
  });

  it('round-trips through JSON', () => {
    const jar = new CookieJar();
    jar.setCookies(site, ['a=1; Domain=example.com; Path=/; Max-Age=3600']);
    const restored = new CookieJar(JSON.parse(JSON.stringify(jar)));
    expect(restored.cookieHeader(site)).toBe('a=1');
  });
});

describe('isCloudflareChallenge', () => {
  it('recognises the cf-mitigated header and a Cloudflare-served challenge page only', () => {
    expect(isCloudflareChallenge(403, new Headers({ 'cf-mitigated': 'challenge' }), '')).toBe(true);
    expect(
      isCloudflareChallenge(
        503,
        new Headers({ server: 'cloudflare' }),
        '<title>Just a moment...</title>',
      ),
    ).toBe(true);
    // Not served by Cloudflare, or not an error status: ordinary pages.
    expect(isCloudflareChallenge(403, new Headers(), '<title>Just a moment...</title>')).toBe(
      false,
    );
    expect(
      isCloudflareChallenge(
        200,
        new Headers({ server: 'cloudflare' }),
        '<title>Just a moment</title>',
      ),
    ).toBe(false);
  });
});
