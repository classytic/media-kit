import type { MediaRepository } from '../repositories/media.repository.js';
import type { StorageDriver } from '../types/storage.js';
import { storageBudgetError } from '../storage-budget.js';

/** Reserve the exact signed byte length; unsupported upload paths must not bypass quotas. */
export async function signBudgetedUpload(input: {
  repository: Pick<MediaRepository, 'storageBudget'>;
  driver: StorageDriver;
  key: string;
  contentType: string;
  size?: number;
  organizationId?: unknown;
  expiresIn?: number;
}) {
  const { repository, driver, key, contentType, size, organizationId } = input;
  const budget = repository.storageBudget;
  if (!budget) return driver.getSignedUploadUrl!(key, contentType, input.expiresIn);
  if (!driver.exactUploadSize || !Number.isSafeInteger(size) || !size || size < 0 || !organizationId) {
    throw storageBudgetError(
      'media.quota.exact_size_required',
      'Quota-managed uploads require a tenant, positive byte size and a driver that signs the exact upload length.',
      400,
    );
  }
  const expiresIn = input.expiresIn ?? 900;
  if (!Number.isInteger(expiresIn) || expiresIn < 1 || expiresIn > 3600) {
    throw storageBudgetError(
      'media.quota.invalid_expiry',
      'Upload URL lifetime must be between 1 and 3600 seconds.',
      400,
    );
  }
  await budget.reserve({
    key,
    organizationId: String(organizationId),
    bytes: size,
    expiresAt: new Date(Date.now() + (expiresIn + 60) * 1000),
  });
  return driver.getSignedUploadUrl!(key, contentType, expiresIn, { size });
}

export function assertBudgetedDirectOnly(repository: Pick<MediaRepository, 'storageBudget'>): void {
  if (repository.storageBudget) {
    throw storageBudgetError(
      'media.quota.direct_upload_required',
      'Use the size-bound direct upload flow for quota-managed media.',
      400,
    );
  }
}
