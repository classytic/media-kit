import { describe, expect, it, vi } from 'vitest';
import { S3Provider } from '../../src/providers/s3.provider.js';
import { signBudgetedUpload } from '../../src/operations/storage-budget.js';
import type { StorageBudget } from '../../src/storage-budget.js';

const createBudget = (): StorageBudget => ({
  reserve: vi.fn(async () => {}), assertAllocation: vi.fn(async () => {}),
  release: vi.fn(async () => {}), retain: vi.fn(async () => {}),
  commit: async () => { throw new Error('Not used by signing tests'); }, claimExpired: vi.fn(async () => false),
  usage: vi.fn(async () => ({ usedBytes: 0, limitBytes: 20 })), expired: vi.fn(async () => []),
});
const driver = () => new S3Provider({ bucket: 'quota-test', region: 'auto', endpoint: 'https://example.r2.cloudflarestorage.com', credentials: { accessKeyId: 'test-access', secretAccessKey: 'test-secret' } });

describe('quota-bound presigned writes', () => {
  it('signs content length and reserves before returning a URL', async () => {
    const storageBudget = createBudget();
    const target = await signBudgetedUpload({ repository: { storageBudget }, driver: driver(), key: 'products/test.webp', contentType: 'image/webp', organizationId: 'org-a', size: 123 });
    expect(storageBudget.reserve).toHaveBeenCalledWith(expect.objectContaining({ key: target.key, organizationId: 'org-a', bytes: 123 }));
    expect(new URL(target.uploadUrl).searchParams.get('X-Amz-SignedHeaders')?.split(';')).toContain('content-length');
    expect(target.expiresIn).toBe(900);
  });
  it('rejects missing/invalid sizes and excessive URL lifetimes before reserving', async () => {
    const storageBudget = createBudget();
    for (const size of [undefined, 0, -1, 1.5, Number.MAX_SAFE_INTEGER + 1]) {
      await expect(signBudgetedUpload({ repository: { storageBudget }, driver: driver(), key: 'test.webp', contentType: 'image/webp', organizationId: 'org-a', size })).rejects.toMatchObject({ code: 'media.quota.exact_size_required' });
    }
    await expect(signBudgetedUpload({ repository: { storageBudget }, driver: driver(), key: 'test.webp', contentType: 'image/webp', organizationId: 'org-a', size: 1, expiresIn: 3601 })).rejects.toMatchObject({ code: 'media.quota.invalid_expiry' });
    expect(storageBudget.reserve).not.toHaveBeenCalled();
  });
  it('returns no upload target when the store is full', async () => {
    const storageBudget = createBudget();
    storageBudget.reserve = vi.fn(async () => { throw Object.assign(new Error('full'), { code: 'media.quota.exceeded' }); });
    const storage = driver();
    const signing = vi.spyOn(storage, 'getSignedUploadUrl');
    await expect(signBudgetedUpload({ repository: { storageBudget }, driver: storage, key: 'test.webp', contentType: 'image/webp', organizationId: 'org-a', size: 1 })).rejects.toMatchObject({ code: 'media.quota.exceeded' });
    expect(signing).not.toHaveBeenCalled();
  });
});
