/**
 * Typed event payload interfaces.
 *
 * Each event in MEDIA_EVENTS has a corresponding payload type.
 * MediaEventMap provides type-safe access: MediaEventMap['media:asset.uploaded']
 */

// ── Asset lifecycle payloads ─────────────────────────────────

export interface AssetUploadedPayload {
  assetId: string;
  filename: string;
  mimeType: string;
  size: number;
  folder: string;
  key: string;
  url: string;
  hash: string;
}

export interface AssetReplacedPayload {
  assetId: string;
  filename: string;
  mimeType: string;
  size: number;
  previousKey: string;
  newKey: string;
}

export interface AssetDeletedPayload {
  assetId: string;
  key: string;
  variantKeys: string[];
}

export interface AssetSoftDeletedPayload {
  assetId: string;
  deletedAt: Date;
}

export interface AssetRestoredPayload {
  assetId: string;
}

export interface AssetMovedPayload {
  assetIds: string[];
  fromFolder: string;
  toFolder: string;
  modifiedCount: number;
}

export interface AssetImportedPayload {
  assetId: string;
  sourceUrl: string;
  filename: string;
  mimeType: string;
  size: number;
}

export interface AssetPurgedPayload {
  count: number;
  olderThan?: Date;
}

// ── Tag payloads ──────────────────────────────────────────

export interface AssetTaggedPayload {
  assetId: string;
  tags: string[];
}

export interface AssetUntaggedPayload {
  assetId: string;
  tags: string[];
}

// ── Focal point ───────────────────────────────────────────

export interface FocalPointSetPayload {
  assetId: string;
  focalPoint: { x: number; y: number };
}

// ── Folder payloads ───────────────────────────────────────

export interface FolderRenamedPayload {
  oldPath: string;
  newPath: string;
  modifiedCount: number;
}

export interface FolderDeletedPayload {
  folder: string;
  deletedCount: number;
}

// ── Upload flow payloads ──────────────────────────────────

export interface UploadConfirmedPayload {
  assetId: string;
  key: string;
  filename: string;
  mimeType: string;
  size: number;
}

export interface MultipartCompletedPayload {
  assetId: string;
  key: string;
  filename: string;
  size: number;
}

// ── Batch payloads ────────────────────────────────────────

export interface BatchDeletedPayload {
  deletedIds: string[];
  failedIds: string[];
}

// ── Event map (name → payload) ────────────────────────────

export interface MediaEventMap {
  [key: `media:${string}`]: unknown;
}

// Concrete mappings for type-safe usage
export interface TypedMediaEventMap {
  'media:asset.uploaded': AssetUploadedPayload;
  'media:asset.replaced': AssetReplacedPayload;
  'media:asset.deleted': AssetDeletedPayload;
  'media:asset.softDeleted': AssetSoftDeletedPayload;
  'media:asset.restored': AssetRestoredPayload;
  'media:asset.moved': AssetMovedPayload;
  'media:asset.imported': AssetImportedPayload;
  'media:asset.purged': AssetPurgedPayload;
  'media:asset.tagged': AssetTaggedPayload;
  'media:asset.untagged': AssetUntaggedPayload;
  'media:asset.focalPointSet': FocalPointSetPayload;
  'media:folder.renamed': FolderRenamedPayload;
  'media:folder.deleted': FolderDeletedPayload;
  'media:upload.confirmed': UploadConfirmedPayload;
  'media:upload.multipartCompleted': MultipartCompletedPayload;
  'media:batch.deleted': BatchDeletedPayload;
}
