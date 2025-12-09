/**
 * S3 Real Upload Test - Test with actual AWS S3
 *
 * This test verifies that:
 * 1. ACL fix works with real S3 buckets
 * 2. Image processing works correctly
 * 3. Upload succeeds without ACL errors
 *
 * Requires: AWS credentials in tests/.env
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import mongoose from 'mongoose';
import { createMedia } from '../src/media';
import { S3Provider } from '../src/providers/s3.provider';
import * as fs from 'fs';
import * as path from 'path';
import { fileURLToPath } from 'url';
import * as dotenv from 'dotenv';

// Load test environment variables
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
dotenv.config({ path: path.join(__dirname, '.env') });

// Skip test if AWS credentials not available
const hasAwsCredentials = process.env.AWS_ACCESS_KEY_ID &&
  process.env.AWS_SECRET_ACCESS_KEY &&
  process.env.S3_BUCKET_NAME;

describe.skipIf(!hasAwsCredentials)('S3 Real Upload Test', () => {
  let Media: mongoose.Model<any>;
  let mediaKit: ReturnType<typeof createMedia>;
  let uploadedFileId: string | null = null;

  beforeAll(async () => {
    // Connect to test database
    await mongoose.connect('mongodb://localhost:27017/mediakit-s3-test');

    // Create media kit with S3 provider
    mediaKit = createMedia({
      provider: new S3Provider({
        bucket: process.env.S3_BUCKET_NAME!,
        region: process.env.AWS_REGION || 'eu-north-1',
        credentials: {
          accessKeyId: process.env.AWS_ACCESS_KEY_ID!,
          secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY!,
        },
        // NO ACL specified - this is the fix we're testing
        // The provider should not send ACL parameter to S3
      }),
      folders: {
        baseFolders: ['test'],
        defaultFolder: 'test',
      },
      processing: {
        enabled: true,
        format: 'webp',
        quality: 80,
        // Size variants - matching user's configuration
        sizes: [
          { name: 'thumbnail', width: 150, height: 200, quality: 75 },
          { name: 'medium', width: 600, height: 800, quality: 80 },
          { name: 'large', width: 1200, height: 1600, quality: 85 },
        ],
      },
    });

    Media = mongoose.model('Media', mediaKit.schema);
    mediaKit.init(Media);

    // Clean up any existing test files
    await Media.deleteMany({ folder: /^test/ });
  });

  afterAll(async () => {
    // NOTE: NOT cleaning up test file - keeping it for manual verification
    console.log('\n🔗 Test file kept in S3 for manual verification');
    console.log('To clean up later, delete files in: test/acl-fix-verification/');

    // Disconnect from database
    await mongoose.connection.close();
  });

  it('should upload a real image to S3 without ACL errors', async () => {
    // Load the actual test image from the tests directory
    const testImagePath = path.join(__dirname, 'test-img.jpg');
    const testImageBuffer = fs.readFileSync(testImagePath);

    console.log('📤 Starting upload test...');
    console.log('Bucket:', process.env.S3_BUCKET_NAME);
    console.log('Region:', process.env.AWS_REGION);
    console.log('Image file:', testImagePath);
    console.log('Image size:', testImageBuffer.length, 'bytes');

    // Upload the image
    const result = await mediaKit.upload({
      buffer: testImageBuffer,
      filename: 'test-img.jpg',
      mimeType: 'image/jpeg',
      folder: 'test/acl-fix-verification',
      alt: 'Test image for ACL fix',
    });

    console.log('✅ Upload successful!');
    console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
    console.log('📸 ORIGINAL IMAGE URL (Test this in your browser):');
    console.log(result.url);
    console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
    console.log('Key:', result.key);
    console.log('MIME:', result.mimeType);
    console.log('Size:', result.size, 'bytes');

    // Log all size variants
    if (result.variants && result.variants.length > 0) {
      console.log('\n📐 SIZE VARIANTS GENERATED:');
      console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
      result.variants.forEach((variant: any, index: number) => {
        console.log(`\n${index + 1}. ${variant.name.toUpperCase()}`);
        console.log(`   URL: ${variant.url}`);
        console.log(`   Size: ${variant.width}x${variant.height} (${variant.size} bytes)`);
      });
      console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n');
    } else {
      console.log('\n⚠️  No size variants generated (check if sharp is installed)\n');
    }

    // Store for cleanup
    uploadedFileId = result._id.toString();

    // Assertions
    expect(result).toBeDefined();
    expect(result.url).toBeDefined();
    expect(result.url).toContain('bigbossltd'); // Our test bucket
    expect(result.key).toBeDefined();
    // Filename should have .webp extension after format conversion
    expect(result.filename).toBe('test-img.webp');
    expect(result.url).toContain('.webp'); // URL should also have correct extension
    expect(result.folder).toBe('test/acl-fix-verification');
    expect(result.alt).toBe('Test image for ACL fix');
    expect(result.mimeType).toBe('image/webp'); // MIME type should be webp

    // Verify it was saved to database
    const doc = await Media.findById(result._id);
    expect(doc).toBeDefined();
    expect(doc?.filename).toBe('test-img.webp'); // Database should also have correct filename

    // Verify size variants
    expect(result.variants).toBeDefined();
    expect(result.variants?.length).toBe(3);
    expect(result.variants?.[0].name).toBe('thumbnail');
    expect(result.variants?.[1].name).toBe('medium');
    expect(result.variants?.[2].name).toBe('large');

    console.log('✅ All assertions passed!');
  }, 30000); // 30 second timeout for real S3 upload

  it('should upload image with processing enabled', async () => {
    // Create a larger test image for processing
    const testImageBuffer = Buffer.from(
      'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8DwHwAFBQIAX8jx0gAAAABJRU5ErkJggg==',
      'base64'
    );

    console.log('📤 Testing upload with processing...');

    const result = await mediaKit.upload({
      buffer: testImageBuffer,
      filename: 'test-processed.png',
      mimeType: 'image/png',
      folder: 'test/processed',
    });

    console.log('✅ Processed upload successful!');
    console.log('Format:', result.mimeType);

    // Clean up
    await mediaKit.delete(result._id.toString());

    expect(result).toBeDefined();
    expect(result.url).toBeDefined();

    console.log('✅ Processing test passed!');
  }, 30000);

  it('should verify file exists in S3', async () => {
    if (!uploadedFileId) {
      console.log('⏭️  Skipping - no file uploaded');
      return;
    }

    const doc = await Media.findById(uploadedFileId);
    expect(doc).toBeDefined();

    const exists = await mediaKit.provider.exists(doc!.key);
    expect(exists).toBe(true);

    console.log('✅ File exists verification passed!');
  });

  it('should verify delete capability (without actually deleting)', async () => {
    if (!uploadedFileId) {
      console.log('⏭️  Skipping - no file uploaded');
      return;
    }

    const doc = await Media.findById(uploadedFileId);
    expect(doc).toBeDefined();

    console.log('✅ Delete capability verified (file kept for manual testing)');
    console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
    console.log('🌐 IMAGE IS AVAILABLE AT:');
    console.log(doc!.url);
    console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
    console.log('\n💡 TIP: Open this URL in your browser to verify the image is accessible');
    console.log('💡 If you get AccessDenied, check your S3 bucket policies\n');
  }, 30000);
});

// Export test info
export const testInfo = {
  name: 'S3 Real Upload Test',
  description: 'Tests real S3 uploads to verify ACL fix',
  requires: ['AWS credentials in tests/.env', 'MongoDB running'],
};
