/**
 * Complete Example: Media Kit with Mongokit
 *
 * Shows all key features:
 * - S3 storage provider
 * - Mongokit pagination (offset & cursor)
 * - Multi-tenancy
 * - Repository access
 */

import mongoose from 'mongoose';
import { createMedia } from '@classytic/media-kit';
import { S3Provider } from '@classytic/media-kit/providers/s3';

// Connect to MongoDB
await mongoose.connect(process.env.MONGODB_URI!);

// Create media kit
const media = createMedia({
  provider: new S3Provider({
    bucket: process.env.S3_BUCKET!,
    region: process.env.AWS_REGION!,
    // Note: ACL defaults to undefined (no ACL parameter sent to S3)
    // Use bucket policies for access control instead of ACLs
    // acl: 'public-read', // Only set if your bucket explicitly requires ACLs
  }),
  folders: {
    baseFolders: ['products', 'users', 'blog'],
    defaultFolder: 'general',
  },
  processing: {
    enabled: true,
    format: 'webp',
    quality: 80,
    sizes: [
      { name: 'thumbnail', width: 150, height: 150 },
      { name: 'medium', width: 800 },
    ],
    generateAlt: true,
  },
  multiTenancy: {
    enabled: true,
    field: 'organizationId',
  },
});

// Create model and initialize
const Media = mongoose.model('Media', media.schema);
media.init(Media);

// =============================================
// UPLOAD
// =============================================

const uploaded = await media.upload(
  {
    buffer: Buffer.from('...'), // Your file buffer
    filename: 'product-photo.jpg',
    mimeType: 'image/jpeg',
    folder: 'products',
  },
  { organizationId: 'org_123', userId: 'user_456' }
);

console.log('Uploaded:', uploaded.url);
console.log('Alt:', uploaded.alt); // Auto-generated: "Product photo"
console.log('Variants:', uploaded.variants?.map(v => v.name)); // ['thumbnail', 'medium']

// =============================================
// PAGINATION - Mongokit powered
// =============================================

// Offset pagination (page-based)
const page1 = await media.getAll(
  { page: 1, limit: 20, filters: { folder: 'products' } },
  { organizationId: 'org_123' }
);

if (page1.method === 'offset') {
  console.log(`Page ${page1.page} of ${page1.pages}`);
  console.log(`Total: ${page1.total} files`);
}

// Keyset pagination (cursor-based, for infinite scroll)
const stream = await media.getAll(
  { sort: { createdAt: -1 }, limit: 50 },
  { organizationId: 'org_123' }
);

if (stream.method === 'keyset' && stream.hasMore) {
  const nextBatch = await media.getAll(
    { after: stream.next!, sort: { createdAt: -1 }, limit: 50 },
    { organizationId: 'org_123' }
  );
  console.log('Next batch:', nextBatch.docs.length);
}

// =============================================
// REPOSITORY - Direct access for advanced queries
// =============================================

// Get storage analytics
const storage = await media.repository.getTotalStorageUsed({ organizationId: 'org_123' });
console.log('Total storage:', storage, 'bytes');

// Get storage breakdown by folder
const breakdown = await media.repository.getStorageByFolder({ organizationId: 'org_123' });
breakdown.forEach(f => {
  console.log(`${f.folder}: ${f.count} files, ${f.size} bytes (${f.percentage}%)`);
});

// Get recent uploads
const recent = await media.repository.getRecentUploads(5, { organizationId: 'org_123' });
console.log('Recent:', recent.map(f => f.filename));

// Search by MIME type
const images = await media.repository.getByMimeType('image/*', { limit: 10 });
console.log('Images:', images.docs.length);

// =============================================
// FOLDER OPERATIONS
// =============================================

// Get folder tree for file explorer UI
const tree = await media.getFolderTree({ organizationId: 'org_123' });
tree.folders.forEach(folder => {
  console.log(`${folder.name}: ${folder.stats.count} files`);
});

// Get folder stats
const stats = await media.getFolderStats('products', { organizationId: 'org_123' });
console.log('Products folder:', stats.totalFiles, 'files,', stats.totalSize, 'bytes');

// Move files to different folder
await media.move(['file_id_1', 'file_id_2'], 'products/archived', { organizationId: 'org_123' });

// =============================================
// DELETE
// =============================================

// Delete single file (removes from storage + database)
await media.delete(uploaded._id.toString(), { organizationId: 'org_123' });

// Delete entire folder
const result = await media.deleteFolder('products/old', { organizationId: 'org_123' });
console.log(`Deleted ${result.success.length} files`);
