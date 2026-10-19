import type { ClientSession } from 'mongoose';

/** Reserve physical bytes before signing; retain them until storage deletion succeeds. */
export interface StorageAllocation {
  key: string;
  organizationId: string;
  bytes: number;
  expiresAt: Date;
}

export interface StorageBudget {
  reserve(allocation: StorageAllocation): Promise<void>;
  assertAllocation(key: string, organizationId: string, bytes: number): Promise<void>;
  release(key: string): Promise<void>;
  retain(key: string): Promise<void>;
  commit<T>(
    files: readonly { key: string; bytes: number }[],
    organizationId: string,
    create: (session: ClientSession) => Promise<T>,
  ): Promise<T>;
  claimExpired(key: string, before: Date): Promise<boolean>;
  usage(organizationId: string): Promise<{ usedBytes: number; limitBytes: number }>;
  expired(before: Date, limit: number): Promise<StorageAllocation[]>;
}

export function storageBudgetError(
  code: string,
  message: string,
  status = 409,
): Error & { code: string; status: number } {
  return Object.assign(new Error(message), { code, status });
}

export function assertAllocationInput(allocation: StorageAllocation): void {
  if (
    !allocation.key ||
    !allocation.organizationId ||
    !Number.isSafeInteger(allocation.bytes) ||
    allocation.bytes <= 0 ||
    !Number.isFinite(allocation.expiresAt.getTime())
  ) {
    throw storageBudgetError(
      'media.quota.invalid_allocation',
      'A tenant, key, positive byte size and expiry are required.',
      400,
    );
  }
}
