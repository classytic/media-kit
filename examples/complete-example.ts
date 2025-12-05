/**
 * Complete Example: Media Kit with All Features
 *
 * This example demonstrates all major features:
 * - Multi-size generation
 * - Alt text auto-generation
 * - Event hooks
 * - Multi-tenancy
 * - Mongokit integration
 */

import mongoose from 'mongoose';
import { createMedia } from '@classytic/media-kit';
import { S3Provider } from '@classytic/media-kit/providers/s3';

// Connect to MongoDB
await mongoose.connect(process.env.MONGODB_URI!);

// Create media kit with all features enabled
const media = createMedia({
  // S3 Storage
  provider: new S3Provider({
    bucket: process.env.S3_BUCKET!,
    region: process.env.AWS_REGION!,
    credentials: {
      accessKeyId: process.env.AWS_ACCESS_KEY_ID!,
      secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY!,
    },
  }),

  // Folder configuration
  folders: {
    baseFolders: ['products', 'users', 'blog', 'documents'],
    defaultFolder: 'general',
    contentTypeMap: {
      product: ['products'],
      avatar: ['users/avatars'],
      blog: ['blog'],
    },
  },

  // Image processing with multi-size generation
  processing: {
    enabled: true,
    format: 'webp',
    quality: 80,
    maxWidth: 2048,

    // Generate multiple sizes automatically
    sizes: [
      { name: 'thumbnail', width: 150, height: 150 },
      { name: 'small', width: 400 },
      { name: 'medium', width: 800 },
      { name: 'large', width: 1920 },
    ],

    // Auto-generate alt text for accessibility
    generateAlt: true,

    // Content-specific aspect ratios
    aspectRatios: {
      product: { aspectRatio: 3 / 4, fit: 'cover' },
      avatar: { aspectRatio: 1, fit: 'cover' },
      blog: { preserveRatio: true },
    },
  },

  // Multi-tenancy for SaaS apps
  multiTenancy: {
    enabled: true,
    field: 'organizationId',
    required: true,
  },

  // File restrictions
  fileTypes: {
    allowed: ['image/*', 'application/pdf', 'video/*'],
    maxSize: 50 * 1024 * 1024, // 50MB
  },

  // Logging
  logger: console,
});

// Create Mongoose model
const Media = mongoose.model('Media', media.schema);

// Initialize media kit
media.init(Media);

// ==================================================
// EVENT HOOKS - Add custom logic
// ==================================================

// Before upload - validation, preprocessing
media.on('before:upload', async (event) => {
  console.log(`[Before Upload] ${event.data.filename}`);

  // Custom validation
  if (event.data.filename.includes('test')) {
    throw new Error('Test files not allowed');
  }

  // Add custom metadata
  if (event.context?.userId) {
    console.log(`User ${event.context.userId} is uploading`);
  }
});

// After upload - notifications, indexing
media.on('after:upload', async (event) => {
  const { result } = event;
  console.log(`[Uploaded] ${result.url}`);

  // Send notification
  console.log(`✉️  Notification sent for ${result.filename}`);

  // Update search index
  console.log(`🔍 Indexed ${result.filename}`);

  // Log analytics
  console.log(`📊 Analytics logged`);
});

// Error handling
media.on('error:upload', async (event) => {
  console.error(`[Upload Error] ${event.error.message}`);
  // Log to error tracking service (Sentry, etc.)
});

// ==================================================
// USAGE EXAMPLES
// ==================================================

// Example 1: Upload with all features
async function uploadProductImage() {
  const imageBuffer = Buffer.from('...'); // Your image buffer

  const uploaded = await media.upload(
    {
      buffer: imageBuffer,
      filename: 'red-running-shoes-nike.jpg',
      mimeType: 'image/jpeg',
      folder: 'products/shoes',
      title: 'Nike Running Shoes',
      // alt is auto-generated from filename
    },
    {
      organizationId: 'org_123',
      userId: 'user_456',
    }
  );

  console.log('Main image:', uploaded.url);
  console.log('Alt text:', uploaded.alt); // "Red running shoes nike"
  console.log('Dimensions:', uploaded.dimensions);

  // Access generated size variants
  uploaded.variants?.forEach((variant) => {
    console.log(`${variant.name}: ${variant.url} (${variant.width}x${variant.height})`);
  });

  return uploaded;
}

// Example 2: Batch upload
async function uploadMultiple() {
  const files = [
    { buffer: Buffer.from('...'), filename: 'product-1.jpg', mimeType: 'image/jpeg' },
    { buffer: Buffer.from('...'), filename: 'product-2.jpg', mimeType: 'image/jpeg' },
    { buffer: Buffer.from('...'), filename: 'product-3.jpg', mimeType: 'image/jpeg' },
  ];

  const results = await media.uploadMany(
    files.map((f) => ({
      ...f,
      folder: 'products/featured',
    })),
    { organizationId: 'org_123' }
  );

  console.log(`Uploaded ${results.length} files`);
  return results;
}

// Example 3: Paginated listing with mongokit
async function listMediaFiles(orgId: string, page = 1) {
  const result = await Media.find({ organizationId: orgId })
    .sort({ createdAt: -1 })
    .limit(20)
    .skip((page - 1) * 20)
    .lean();

  return result;
}

// Example 4: Search and filter
async function searchMedia(orgId: string, query: string) {
  const results = await Media.find({
    organizationId: orgId,
    $or: [
      { filename: { $regex: query, $options: 'i' } },
      { alt: { $regex: query, $options: 'i' } },
      { title: { $regex: query, $options: 'i' } },
    ],
  })
    .limit(50)
    .lean();

  return results;
}

// Example 5: Get folder tree for UI
async function getFolderStructure(orgId: string) {
  const tree = await media.getFolderTree({ organizationId: orgId });

  console.log('Folder structure:');
  tree.folders.forEach((folder) => {
    console.log(`├─ ${folder.name} (${folder.stats.count} files)`);
    folder.children.forEach((child) => {
      console.log(`│  ├─ ${child.name} (${child.stats.count} files)`);
    });
  });

  return tree;
}

// Example 6: Delete with cleanup
async function deleteMedia(id: string, orgId: string) {
  // This will:
  // 1. Delete from storage (main + all variants)
  // 2. Delete from database
  // 3. Emit events
  const deleted = await media.delete(id, { organizationId: orgId });

  if (deleted) {
    console.log('✅ Deleted successfully');
  }

  return deleted;
}

// ==================================================
// EXPRESS API EXAMPLE
// ==================================================

import express from 'express';
import multer from 'multer';

const app = express();
const upload = multer({ storage: multer.memoryStorage() });

// Upload endpoint
app.post('/api/media/upload', upload.single('file'), async (req, res) => {
  try {
    if (!req.file) {
      return res.status(400).json({ error: 'No file provided' });
    }

    const uploaded = await media.upload(
      {
        buffer: req.file.buffer,
        filename: req.file.originalname,
        mimeType: req.file.mimetype,
        folder: req.body.folder || 'general',
        alt: req.body.alt,
        title: req.body.title,
      },
      {
        organizationId: req.user.organizationId, // From auth middleware
        userId: req.user.id,
      }
    );

    res.json({
      success: true,
      data: {
        id: uploaded._id,
        url: uploaded.url,
        alt: uploaded.alt,
        dimensions: uploaded.dimensions,
        variants: uploaded.variants,
      },
    });
  } catch (error) {
    console.error('Upload error:', error);
    res.status(500).json({ error: error.message });
  }
});

// List endpoint with pagination
app.get('/api/media', async (req, res) => {
  try {
    const { page = 1, limit = 20, folder, search } = req.query;

    const query: any = {
      organizationId: req.user.organizationId,
    };

    if (folder) {
      query.folder = { $regex: `^${folder}` };
    }

    if (search) {
      query.$or = [
        { filename: { $regex: search, $options: 'i' } },
        { alt: { $regex: search, $options: 'i' } },
      ];
    }

    const [docs, total] = await Promise.all([
      Media.find(query)
        .sort({ createdAt: -1 })
        .limit(Number(limit))
        .skip((Number(page) - 1) * Number(limit))
        .lean(),
      Media.countDocuments(query),
    ]);

    res.json({
      success: true,
      data: docs,
      pagination: {
        page: Number(page),
        limit: Number(limit),
        total,
        pages: Math.ceil(total / Number(limit)),
      },
    });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Delete endpoint
app.delete('/api/media/:id', async (req, res) => {
  try {
    const deleted = await media.delete(req.params.id, {
      organizationId: req.user.organizationId,
    });

    if (!deleted) {
      return res.status(404).json({ error: 'Media not found' });
    }

    res.json({ success: true });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Folder tree endpoint
app.get('/api/media/folders', async (req, res) => {
  try {
    const tree = await media.getFolderTree({
      organizationId: req.user.organizationId,
    });

    res.json({ success: true, data: tree });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.listen(3000, () => {
  console.log('✅ Server running on port 3000');
});

export { media, Media };
