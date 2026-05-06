/**
 * Integration tests — multi-provider (DriverRegistry + providers config)
 *
 * Covers:
 *   - createMedia({ providers, defaultProvider }) config
 *   - upload({ provider }) routes to correct driver
 *   - media.provider stored on IMedia document
 *   - hardDelete routes delete to the correct provider
 *   - replace routes to the correct provider (input.provider or existing doc's)
 *   - engine.registry exposed and correct
 *   - engine.driver is shorthand for default driver
 *   - backward compat: single driver: still works unchanged
 *   - DriverRegistry construction and resolve() error cases
 *   - unknown provider name at upload time throws
 */

import { describe, it, expect, afterAll, beforeEach, afterEach } from 'vitest';
import mongoose from 'mongoose';
import { MongoMemoryServer } from 'mongodb-memory-server';
import { createMedia } from '../../src/engine/create-media.js';
import { DriverRegistry } from '../../src/providers/driver-registry.js';
import { MemoryStorageDriver } from '../helpers/memory-driver.js';
import { teardownTestMongo } from '../helpers/create-test-engine.js';

const BUF = (s: string) => Buffer.from(s, 'utf-8');

// ── Shared Mongo ─────────────────────────────────────────────────────────────

let mongo: MongoMemoryServer | null = null;
let connection: mongoose.Connection | null = null;

async function getConnection(): Promise<mongoose.Connection> {
  if (connection && connection.readyState === 1) return connection;
  mongo = await MongoMemoryServer.create();
  connection = await mongoose.createConnection(mongo.getUri()).asPromise();
  return connection;
}

async function resetCollections(): Promise<void> {
  if (!connection) return;
  const collections = await connection.db?.collections();
  if (collections) for (const c of collections) await c.deleteMany({});
}

// ── DriverRegistry unit tests ─────────────────────────────────────────────────

describe('DriverRegistry', () => {
  it('resolves default driver when no name given', () => {
    const a = new MemoryStorageDriver();
    const b = new MemoryStorageDriver();
    // a and b both have name 'memory' — name collision is fine; registry key is what matters
    const registry = new DriverRegistry({ primary: a, secondary: b }, 'primary');

    expect(registry.resolve()).toBe(a);
    expect(registry.resolve(null)).toBe(a);
    expect(registry.resolve('')).toBe(a);
    expect(registry.defaultDriver).toBe(a);
    expect(registry.defaultName).toBe('primary');
  });

  it('resolves named driver correctly', () => {
    const a = new MemoryStorageDriver();
    const b = new MemoryStorageDriver();
    const registry = new DriverRegistry({ primary: a, secondary: b }, 'primary');

    expect(registry.resolve('secondary')).toBe(b);
    expect(registry.resolve('primary')).toBe(a);
  });

  it('throws on unknown provider name', () => {
    const registry = new DriverRegistry({ only: new MemoryStorageDriver() }, 'only');
    expect(() => registry.resolve('nonexistent')).toThrow(/Unknown provider "nonexistent"/);
    expect(() => registry.resolve('nonexistent')).toThrow(/only/); // lists registered names
  });

  it('throws when defaultProvider is not in drivers', () => {
    expect(() => new DriverRegistry({ a: new MemoryStorageDriver() }, 'b')).toThrow(/defaultProvider "b" is not in providers/);
  });

  it('throws when drivers is empty', () => {
    expect(() => new DriverRegistry({}, 'any')).toThrow(/at least one driver/);
  });

  it('exposes names and has()', () => {
    const registry = new DriverRegistry(
      { s3: new MemoryStorageDriver(), cdn: new MemoryStorageDriver() },
      's3',
    );
    expect(registry.names).toContain('s3');
    expect(registry.names).toContain('cdn');
    expect(registry.has('s3')).toBe(true);
    expect(registry.has('missing')).toBe(false);
  });

  it('DriverRegistry.fromSingle() builds a single-driver registry', () => {
    const d = new MemoryStorageDriver();
    const registry = DriverRegistry.fromSingle(d);
    expect(registry.defaultName).toBe('memory');
    expect(registry.resolve()).toBe(d);
    expect(registry.names).toEqual(['memory']);
  });
});

// ── Engine multi-provider integration tests ───────────────────────────────────

describe('createMedia() — multi-provider', () => {
  afterAll(async () => {
    await teardownTestMongo();
    if (connection) { await connection.close(); connection = null; }
    if (mongo) { await mongo.stop(); mongo = null; }
  });

  beforeEach(async () => {
    await resetCollections();
  });

  describe('config validation', () => {
    it('throws when providers is set without defaultProvider', async () => {
      const conn = await getConnection();
      await expect(
        createMedia({
          connection: conn,
          providers: { a: new MemoryStorageDriver() },
        } as any),
      ).rejects.toThrow(/defaultProvider is required/);
    });

    it('throws when neither driver nor providers is set', async () => {
      const conn = await getConnection();
      await expect(
        createMedia({ connection: conn } as any),
      ).rejects.toThrow(/driver or providers must be specified/);
    });

    it('throws when defaultProvider is not in providers', async () => {
      const conn = await getConnection();
      await expect(
        createMedia({
          connection: conn,
          providers: { a: new MemoryStorageDriver() },
          defaultProvider: 'nonexistent',
        }),
      ).rejects.toThrow(/defaultProvider "nonexistent" is not in providers/);
    });
  });

  describe('engine shape', () => {
    it('exposes registry on engine with all registered drivers', async () => {
      const conn = await getConnection();
      const primary = new MemoryStorageDriver();
      const backup = new MemoryStorageDriver();

      const engine = await createMedia({
        connection: conn,
        providers: { primary, backup },
        defaultProvider: 'primary',
        suppressWarnings: true,
        processing: { enabled: false },
      });

      expect(engine.registry).toBeDefined();
      expect(engine.registry.defaultName).toBe('primary');
      expect(engine.registry.defaultDriver).toBe(primary);
      expect(engine.registry.has('backup')).toBe(true);
      expect(engine.registry.names).toContain('primary');
      expect(engine.registry.names).toContain('backup');

      // engine.driver is shorthand for default
      expect(engine.driver).toBe(primary);

      await engine.dispose();
    });
  });

  describe('backward compat — single driver:', () => {
    it('single driver: still works unchanged', async () => {
      const conn = await getConnection();
      const driver = new MemoryStorageDriver();

      const engine = await createMedia({
        connection: conn,
        driver,
        suppressWarnings: true,
        processing: { enabled: false },
      });

      expect(engine.driver).toBe(driver);
      expect(engine.registry.defaultDriver).toBe(driver);
      expect(engine.registry.defaultName).toBe('memory');

      const media = await engine.repositories.media.upload({
        buffer: BUF('hello'),
        filename: 'test.txt',
        mimeType: 'text/plain',
      });

      expect(media.provider).toBe('memory');
      expect(await driver.exists(media.key)).toBe(true);

      await engine.dispose();
    });
  });

  describe('upload({ provider })', () => {
    it('routes upload to default provider when no provider specified', async () => {
      const conn = await getConnection();
      const primary = new MemoryStorageDriver();
      const secondary = new MemoryStorageDriver();

      const engine = await createMedia({
        connection: conn,
        providers: { primary, secondary },
        defaultProvider: 'primary',
        suppressWarnings: true,
        processing: { enabled: false },
      });

      const media = await engine.repositories.media.upload({
        buffer: BUF('data'),
        filename: 'file.txt',
        mimeType: 'text/plain',
      });

      expect(media.provider).toBe('primary');
      expect(await primary.exists(media.key)).toBe(true);
      expect(await secondary.exists(media.key)).toBe(false);

      await engine.dispose();
    });

    it('routes upload to named provider when provider is specified', async () => {
      const conn = await getConnection();
      const primary = new MemoryStorageDriver();
      const secondary = new MemoryStorageDriver();

      const engine = await createMedia({
        connection: conn,
        providers: { primary, secondary },
        defaultProvider: 'primary',
        suppressWarnings: true,
        processing: { enabled: false },
      });

      const media = await engine.repositories.media.upload({
        buffer: BUF('data'),
        filename: 'file.txt',
        mimeType: 'text/plain',
        provider: 'secondary',
      });

      expect(media.provider).toBe('secondary');
      expect(await secondary.exists(media.key)).toBe(true);
      expect(await primary.exists(media.key)).toBe(false);

      await engine.dispose();
    });

    it('different files uploaded to different providers coexist', async () => {
      const conn = await getConnection();
      const s3 = new MemoryStorageDriver();
      const cdn = new MemoryStorageDriver();

      const engine = await createMedia({
        connection: conn,
        providers: { s3, cdn },
        defaultProvider: 's3',
        suppressWarnings: true,
        processing: { enabled: false },
      });

      const m1 = await engine.repositories.media.upload({
        buffer: BUF('original'),
        filename: 'original.jpg',
        mimeType: 'image/jpeg',
        provider: 's3',
      });

      const m2 = await engine.repositories.media.upload({
        buffer: BUF('thumbnail'),
        filename: 'thumb.jpg',
        mimeType: 'image/jpeg',
        provider: 'cdn',
      });

      expect(m1.provider).toBe('s3');
      expect(m2.provider).toBe('cdn');
      expect(await s3.exists(m1.key)).toBe(true);
      expect(await cdn.exists(m2.key)).toBe(true);
      // Files don't leak across providers
      expect(await cdn.exists(m1.key)).toBe(false);
      expect(await s3.exists(m2.key)).toBe(false);

      await engine.dispose();
    });

    it('throws on unknown provider name at upload time', async () => {
      const conn = await getConnection();
      const engine = await createMedia({
        connection: conn,
        providers: { main: new MemoryStorageDriver() },
        defaultProvider: 'main',
        suppressWarnings: true,
        processing: { enabled: false },
      });

      await expect(
        engine.repositories.media.upload({
          buffer: BUF('x'),
          filename: 'x.txt',
          mimeType: 'text/plain',
          provider: 'nonexistent',
        }),
      ).rejects.toThrow(/Unknown provider "nonexistent"/);

      await engine.dispose();
    });
  });

  describe('hardDelete() — routes to correct provider', () => {
    it('deletes from the provider that stored the file', async () => {
      const conn = await getConnection();
      const primary = new MemoryStorageDriver();
      const secondary = new MemoryStorageDriver();

      const engine = await createMedia({
        connection: conn,
        providers: { primary, secondary },
        defaultProvider: 'primary',
        suppressWarnings: true,
        processing: { enabled: false },
      });

      // Upload to secondary
      const media = await engine.repositories.media.upload({
        buffer: BUF('content'),
        filename: 'file.txt',
        mimeType: 'text/plain',
        provider: 'secondary',
      });

      expect(await secondary.exists(media.key)).toBe(true);

      // Delete should go to secondary, not primary
      await engine.repositories.media.hardDelete(String(media._id));

      expect(await secondary.exists(media.key)).toBe(false);
      expect(primary.size).toBe(0); // primary untouched

      await engine.dispose();
    });
  });

  describe('replace() — routes to correct provider', () => {
    it('replaces on same provider as original by default', async () => {
      const conn = await getConnection();
      const primary = new MemoryStorageDriver();
      const secondary = new MemoryStorageDriver();

      const engine = await createMedia({
        connection: conn,
        providers: { primary, secondary },
        defaultProvider: 'primary',
        suppressWarnings: true,
        processing: { enabled: false },
      });

      const media = await engine.repositories.media.upload({
        buffer: BUF('v1'),
        filename: 'file.txt',
        mimeType: 'text/plain',
        provider: 'secondary',
      });

      const replaced = await engine.repositories.media.replace(
        String(media._id),
        { buffer: BUF('v2'), filename: 'file.txt', mimeType: 'text/plain' },
      );

      // provider preserved from existing doc
      expect(replaced.provider).toBe('secondary');
      expect(await secondary.exists(replaced.key)).toBe(true);
      expect(primary.size).toBe(0);

      await engine.dispose();
    });

    it('replace() can switch provider via input.provider', async () => {
      const conn = await getConnection();
      const primary = new MemoryStorageDriver();
      const secondary = new MemoryStorageDriver();

      const engine = await createMedia({
        connection: conn,
        providers: { primary, secondary },
        defaultProvider: 'primary',
        suppressWarnings: true,
        processing: { enabled: false },
      });

      const media = await engine.repositories.media.upload({
        buffer: BUF('v1'),
        filename: 'file.txt',
        mimeType: 'text/plain',
        provider: 'primary',
      });

      const replaced = await engine.repositories.media.replace(
        String(media._id),
        {
          buffer: BUF('v2'),
          filename: 'file.txt',
          mimeType: 'text/plain',
          provider: 'secondary', // switch provider on replace
        },
      );

      expect(replaced.provider).toBe('secondary');
      expect(await secondary.exists(replaced.key)).toBe(true);

      await engine.dispose();
    });
  });
});
