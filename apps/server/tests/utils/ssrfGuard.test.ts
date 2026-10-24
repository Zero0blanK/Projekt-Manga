import { describe, it, expect } from 'vitest';
import {
  assertPublicHttpUrl,
  isDisallowedIpAddress,
  isDisallowedRedirectHost,
  UnsafeUrlError,
} from '../../src/utils/ssrfGuard.js';

describe('assertPublicHttpUrl', () => {
  it('rejects non-http(s) protocols', async () => {
    await expect(assertPublicHttpUrl('file:///etc/passwd')).rejects.toBeInstanceOf(UnsafeUrlError);
    await expect(assertPublicHttpUrl('ftp://example.com/x')).rejects.toBeInstanceOf(UnsafeUrlError);
  });

  it('rejects malformed URLs', async () => {
    await expect(assertPublicHttpUrl('not a url')).rejects.toBeInstanceOf(UnsafeUrlError);
  });

  it('rejects loopback IPv4 literals', async () => {
    await expect(assertPublicHttpUrl('http://127.0.0.1/admin')).rejects.toBeInstanceOf(
      UnsafeUrlError,
    );
    await expect(assertPublicHttpUrl('http://127.1.2.3/')).rejects.toBeInstanceOf(UnsafeUrlError);
  });

  it('rejects "localhost"', async () => {
    await expect(assertPublicHttpUrl('http://localhost:5432/')).rejects.toBeInstanceOf(
      UnsafeUrlError,
    );
  });

  it('rejects private IPv4 ranges (10/8, 172.16/12, 192.168/16)', async () => {
    await expect(assertPublicHttpUrl('http://10.0.0.5/')).rejects.toBeInstanceOf(UnsafeUrlError);
    await expect(assertPublicHttpUrl('http://172.16.0.1/')).rejects.toBeInstanceOf(UnsafeUrlError);
    await expect(assertPublicHttpUrl('http://192.168.1.1/')).rejects.toBeInstanceOf(UnsafeUrlError);
  });

  it('rejects the link-local / cloud-metadata range (169.254/16)', async () => {
    await expect(
      assertPublicHttpUrl('http://169.254.169.254/latest/meta-data/'),
    ).rejects.toBeInstanceOf(UnsafeUrlError);
  });

  it('rejects IPv6 loopback and unique-local addresses', async () => {
    await expect(assertPublicHttpUrl('http://[::1]/')).rejects.toBeInstanceOf(UnsafeUrlError);
    await expect(assertPublicHttpUrl('http://[fd00::1]/')).rejects.toBeInstanceOf(UnsafeUrlError);
  });

  it('rejects an IPv4-mapped IPv6 loopback in *hex* form, not just dotted form', async () => {
    // Regression: ::ffff:7f00:1 is 127.0.0.1. The guard used to strip the ::ffff: prefix
    // and hand "7f00:1" to a check that recognised neither IPv4 nor IPv6, so it fell
    // through and reported the address as public — a straight bypass of the whole guard.
    await expect(assertPublicHttpUrl('http://[::ffff:7f00:1]/')).rejects.toBeInstanceOf(
      UnsafeUrlError,
    );
    await expect(assertPublicHttpUrl('http://[::ffff:a00:1]/')).rejects.toBeInstanceOf(
      UnsafeUrlError,
    );
    // The dotted spelling of the same address was already covered; assert both stay so.
    await expect(assertPublicHttpUrl('http://[::ffff:127.0.0.1]/')).rejects.toBeInstanceOf(
      UnsafeUrlError,
    );
  });

  it('parses IPv4-embedded IPv6 literals before applying reserved-range policy', () => {
    expect(isDisallowedIpAddress('::192.0.2.1')).toBe(true);
    expect(isDisallowedIpAddress('64:ff9b::10.0.0.1')).toBe(true);
  });

  it('rejects carrier-grade NAT, benchmarking, multicast and reserved IPv4 ranges', async () => {
    for (const ip of [
      '100.64.0.1',
      '198.18.0.1',
      '224.0.0.1',
      '240.0.0.1',
      '255.255.255.255',
      '192.0.2.1',
      '198.51.100.1',
      '203.0.113.1',
      '192.88.99.1',
    ]) {
      await expect(assertPublicHttpUrl(`http://${ip}/`)).rejects.toBeInstanceOf(UnsafeUrlError);
    }
  });

  it('applies the same reserved-range policy to resolved socket addresses', () => {
    for (const ip of ['198.51.100.1', '203.0.113.1', '2001:db8::1', '64:ff9b::a00:1']) {
      expect(isDisallowedIpAddress(ip), ip).toBe(true);
    }
    expect(isDisallowedIpAddress('93.184.216.34')).toBe(false);
    expect(isDisallowedIpAddress('2606:4700:4700::1111')).toBe(false);
  });

  it('rejects the IPv6 unspecified address and multicast', async () => {
    await expect(assertPublicHttpUrl('http://[::]/')).rejects.toBeInstanceOf(UnsafeUrlError);
    await expect(assertPublicHttpUrl('http://[ff02::1]/')).rejects.toBeInstanceOf(UnsafeUrlError);
    for (const ip of ['2001:db8::1', '2002:c000:0201::1', '3fff::1', '5f00::1']) {
      await expect(assertPublicHttpUrl(`http://[${ip}]/`)).rejects.toBeInstanceOf(UnsafeUrlError);
    }
  });

  it('still accepts a public IPv6 literal', async () => {
    await expect(assertPublicHttpUrl('http://[2606:4700:4700::1111]/')).resolves.toBeInstanceOf(
      URL,
    );
  });

  it('accepts a public IPv4 literal', async () => {
    await expect(assertPublicHttpUrl('http://93.184.216.34/')).resolves.toBeInstanceOf(URL);
  });
});

describe('isDisallowedRedirectHost', () => {
  it('flags loopback/private IP literals and "localhost"', () => {
    expect(isDisallowedRedirectHost('127.0.0.1')).toBe(true);
    expect(isDisallowedRedirectHost('192.168.0.1')).toBe(true);
    expect(isDisallowedRedirectHost('localhost')).toBe(true);
  });

  it('allows a public IP literal or hostname', () => {
    expect(isDisallowedRedirectHost('93.184.216.34')).toBe(false);
    expect(isDisallowedRedirectHost('cdn.example.com')).toBe(false);
  });
});
