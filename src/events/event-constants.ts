/**
 * Media event name constants.
 *
 * Convention: media:resource.verb (PACKAGE_RULES §12)
 * Hosts import these constants for type-safe subscriptions:
 *   engine.events.subscribe(MEDIA_EVENTS.ASSET_UPLOADED, handler)
 */

export const MEDIA_EVENTS = {
  // Asset lifecycle
  ASSET_UPLOADED: 'media:asset.uploaded',
  ASSET_REPLACED: 'media:asset.replaced',
  ASSET_DELETED: 'media:asset.deleted',
  ASSET_SOFT_DELETED: 'media:asset.softDeleted',
  ASSET_RESTORED: 'media:asset.restored',
  ASSET_MOVED: 'media:asset.moved',
  ASSET_IMPORTED: 'media:asset.imported',
  ASSET_PURGED: 'media:asset.purged',

  // Tags
  ASSET_TAGGED: 'media:asset.tagged',
  ASSET_UNTAGGED: 'media:asset.untagged',

  // Focal point
  FOCAL_POINT_SET: 'media:asset.focalPointSet',

  // Folder operations
  FOLDER_RENAMED: 'media:folder.renamed',
  FOLDER_DELETED: 'media:folder.deleted',

  // Presigned upload flow
  UPLOAD_CONFIRMED: 'media:upload.confirmed',
  MULTIPART_COMPLETED: 'media:upload.multipartCompleted',

  // Batch
  BATCH_DELETED: 'media:batch.deleted',

  // Temporal lifecycle
  ASSETS_EXPIRED: 'media:assets.expired',
} as const;

export type MediaEventName = (typeof MEDIA_EVENTS)[keyof typeof MEDIA_EVENTS];
