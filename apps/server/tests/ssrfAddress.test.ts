import { describe, it, expect } from 'vitest';
import { isDisallowedIpAddress } from '../src/utils/ssrfGuard.js';

describe('isDisallowedIpAddress', () => {
  it('refuses private, loopback, metadata and mapped addresses', () => {
    for (const ip of [
      '127.0.0.1',
      '169.254.169.254',
      '10.1.2.3',
      '::1',
      '::',
      '::ffff:127.0.0.1',
      '::ffff:7f00:1',
      '64:ff9b::a9fe:a9fe',
      'fd00::1',
    ]) {
      expect(isDisallowedIpAddress(ip), ip).toBe(true);
    }
  });

  it('allows public addresses', () => {
    for (const ip of ['8.8.8.8', '2606:4700::1']) {
      expect(isDisallowedIpAddress(ip), ip).toBe(false);
    }
  });

  it('refuses a scoped link-local address instead of throwing', () => {
    expect(() => isDisallowedIpAddress('fe80::1%eth0')).not.toThrow();
    expect(isDisallowedIpAddress('fe80::1%eth0')).toBe(true);
  });
});
