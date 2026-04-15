/**
 * Environment helper — env-var presence checks.
 *
 * Per testing-infrastructure.md §3: must not throw at import time.
 * Gate e2e suites with `describe.skipIf(!hasS3())(...)` or `if (hasS3()) { ... }`.
 */

export function hasKey(name: string): boolean {
  const v = process.env[name];
  return typeof v === 'string' && v.length > 0;
}

export function requireEnv(name: string): string {
  const v = process.env[name];
  if (!v) throw new Error(`Missing required env var: ${name}`);
  return v;
}

// ── Provider presence checks ─────────────────────────────────

export function hasS3(): boolean {
  return hasKey('AWS_ACCESS_KEY_ID') && hasKey('AWS_SECRET_ACCESS_KEY') && hasKey('S3_BUCKET_NAME');
}

export function hasGcs(): boolean {
  if (!hasKey('GCS_BUCKET_NAME') || !hasKey('GCS_PROJECT_ID') || !hasKey('GCS_KEY_FILENAME')) {
    return false;
  }
  // Verify the key file actually exists — skip gracefully if the path is stale
  try {
    const fs = require('fs');
    const path = require('path');
    const keyPath = path.resolve(process.cwd(), process.env.GCS_KEY_FILENAME!);
    return fs.existsSync(keyPath);
  } catch {
    return false;
  }
}

export function hasMongo(): boolean {
  return hasKey('MONGODB_URI');
}

// ── Structured accessors ─────────────────────────────────────

export interface S3TestConfig {
  bucket: string;
  region: string;
  accessKeyId: string;
  secretAccessKey: string;
}

export function s3Config(): S3TestConfig {
  return {
    bucket: requireEnv('S3_BUCKET_NAME'),
    region: process.env.AWS_REGION ?? 'us-east-1',
    accessKeyId: requireEnv('AWS_ACCESS_KEY_ID'),
    secretAccessKey: requireEnv('AWS_SECRET_ACCESS_KEY'),
  };
}

export interface GcsTestConfig {
  bucket: string;
  projectId: string;
  keyFilename: string;
}

export function gcsConfig(): GcsTestConfig {
  return {
    bucket: requireEnv('GCS_BUCKET_NAME'),
    projectId: requireEnv('GCS_PROJECT_ID'),
    keyFilename: requireEnv('GCS_KEY_FILENAME'),
  };
}

/**
 * Generate a unique key prefix per test run for isolation.
 * Allows parallel runs and safe cleanup.
 */
export function testKeyPrefix(suite: string): string {
  const runId = process.env.TEST_RUN_ID ?? `${Date.now()}-${process.pid}`;
  return `mediakit-test/${suite}/${runId}`;
}
