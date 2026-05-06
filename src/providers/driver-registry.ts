/**
 * DriverRegistry — runtime registry for named StorageDriver instances.
 *
 * Enables multi-provider setups where different uploads can be routed to
 * different storage backends. The registry is immutable after construction;
 * drivers are resolved by name at call time.
 *
 * @example
 * ```ts
 * const registry = new DriverRegistry(
 *   {
 *     s3: new S3Provider({ bucket: 'originals', region: 'us-east-1' }),
 *     imagekit: new ImageKitProvider({ urlEndpoint: '...', ... }),
 *     imgbb: new ImgbbProvider({ apiKey: process.env.IMGBB_KEY }),
 *   },
 *   's3', // default
 * );
 *
 * registry.resolve();           // → S3Provider (default)
 * registry.resolve('imagekit'); // → ImageKitProvider
 * registry.resolve('imgbb');    // → ImgbbProvider
 * registry.resolve('unknown');  // throws with registered names listed
 * ```
 */

import type { StorageDriver } from '../types.js';

export class DriverRegistry {
  /** All registered drivers, keyed by provider name. Frozen. */
  readonly drivers: Readonly<Record<string, StorageDriver>>;

  /** The default driver instance (shorthand for `drivers[defaultName]`). */
  readonly defaultDriver: StorageDriver;

  /** Name of the default driver. */
  readonly defaultName: string;

  constructor(drivers: Record<string, StorageDriver>, defaultName: string) {
    const names = Object.keys(drivers);
    if (names.length === 0) {
      throw new Error('[media-kit] DriverRegistry: at least one driver is required');
    }
    if (!(defaultName in drivers)) {
      throw new Error(
        `[media-kit] DriverRegistry: defaultProvider "${defaultName}" is not in providers. ` +
          `Available: ${names.join(', ')}`,
      );
    }
    this.drivers = Object.freeze({ ...drivers });
    this.defaultName = defaultName;
    this.defaultDriver = drivers[defaultName]!;
  }

  /**
   * Resolve a driver by name.
   * - No name (undefined / null / '') → default driver.
   * - Unknown name → throws with the list of registered providers.
   */
  resolve(name?: string | null): StorageDriver {
    if (!name) return this.defaultDriver;
    const d = this.drivers[name];
    if (!d) {
      throw new Error(
        `[media-kit] Unknown provider "${name}". ` +
          `Registered: ${Object.keys(this.drivers).join(', ')}`,
      );
    }
    return d;
  }

  /** Names of all registered providers. */
  get names(): string[] {
    return Object.keys(this.drivers);
  }

  /** Whether a named driver is registered. */
  has(name: string): boolean {
    return name in this.drivers;
  }

  /** Build a single-driver registry (used for backward-compat `driver:` shorthand). */
  static fromSingle(driver: StorageDriver): DriverRegistry {
    return new DriverRegistry({ [driver.name]: driver }, driver.name);
  }
}
