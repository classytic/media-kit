/**
 * Pinned-lookup regression tests.
 *
 * `createPinnedLookup` feeds a custom `lookup` to http(s).get so the connection
 * pins to the already-validated IP (DNS-rebinding / TOCTOU guard). Node invokes
 * a custom lookup in two callback shapes; the `{ all: true }` form (default
 * since autoSelectFamily in Node 18+) expects an ARRAY. Returning the legacy
 * triple there made Node throw "Invalid IP address: undefined", crashing every
 * importFromUrl on Node ≥18. These tests lock in both shapes.
 */

import { describe, it, expect } from 'vitest';
import { createPinnedLookup } from '../../src/operations/url-import';

describe('createPinnedLookup', () => {
  it('returns the array shape when called with { all: true } (Node 18+ default)', () => {
    const lookup = createPinnedLookup('93.184.216.34') as unknown as (
      hostname: string,
      options: unknown,
      cb: (err: unknown, addresses: Array<{ address: string; family: number }>) => void,
    ) => void;

    let received: unknown;
    lookup('example.com', { all: true }, (_err, addresses) => {
      received = addresses;
    });

    expect(received).toEqual([{ address: '93.184.216.34', family: 4 }]);
  });

  it('returns the legacy (address, family) triple when all is not set', () => {
    const lookup = createPinnedLookup('93.184.216.34') as unknown as (
      hostname: string,
      options: unknown,
      cb: (err: unknown, address: string, family: number) => void,
    ) => void;

    let addr: string | undefined;
    let fam: number | undefined;
    lookup('example.com', {}, (_err, address, family) => {
      addr = address;
      fam = family;
    });

    expect(addr).toBe('93.184.216.34');
    expect(fam).toBe(4);
  });

  it('supports the 2-arg form where options IS the callback', () => {
    const lookup = createPinnedLookup('93.184.216.34') as unknown as (
      hostname: string,
      cb: (err: unknown, address: string, family: number) => void,
    ) => void;

    let addr: string | undefined;
    lookup('example.com', (_err, address) => {
      addr = address;
    });

    expect(addr).toBe('93.184.216.34');
  });

  it('reports family 6 for IPv6 addresses', () => {
    const lookup = createPinnedLookup('2606:2800:220:1:248:1893:25c8:1946') as unknown as (
      hostname: string,
      options: unknown,
      cb: (err: unknown, addresses: Array<{ address: string; family: number }>) => void,
    ) => void;

    let received: Array<{ address: string; family: number }> | undefined;
    lookup('example.com', { all: true }, (_err, addresses) => {
      received = addresses;
    });

    expect(received).toEqual([{ address: '2606:2800:220:1:248:1893:25c8:1946', family: 6 }]);
  });
});
