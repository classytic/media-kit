/**
 * S3 Test Files Cleanup Script
 *
 * Removes all test files uploaded during S3 integration tests.
 *
 * Usage:
 *   npm run test:cleanup
 *
 * Requires tests/.env with AWS credentials.
 */

import { S3Client, ListObjectsV2Command, DeleteObjectsCommand } from '@aws-sdk/client-s3';
import * as dotenv from 'dotenv';
import * as path from 'path';
import { fileURLToPath } from 'url';

// Load test credentials
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
dotenv.config({ path: path.join(__dirname, '.env') });

const BUCKET = process.env.S3_BUCKET_NAME;
const REGION = process.env.AWS_REGION || 'eu-north-1';
const TEST_PREFIX = 'test/'; // All test files are under this prefix

async function cleanup() {
  if (!process.env.AWS_ACCESS_KEY_ID || !process.env.AWS_SECRET_ACCESS_KEY || !BUCKET) {
    console.error('❌ Missing AWS credentials in tests/.env');
    console.error('Required: AWS_ACCESS_KEY_ID, AWS_SECRET_ACCESS_KEY, S3_BUCKET_NAME');
    process.exit(1);
  }

  console.log('🧹 S3 Test Files Cleanup');
  console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
  console.log(`Bucket: ${BUCKET}`);
  console.log(`Region: ${REGION}`);
  console.log(`Prefix: ${TEST_PREFIX}`);
  console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n');

  const client = new S3Client({
    region: REGION,
    credentials: {
      accessKeyId: process.env.AWS_ACCESS_KEY_ID!,
      secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY!,
    },
  });

  try {
    // List all objects with test prefix
    console.log('📋 Listing test files...');
    const listCommand = new ListObjectsV2Command({
      Bucket: BUCKET,
      Prefix: TEST_PREFIX,
    });

    const listResult = await client.send(listCommand);
    const objects = listResult.Contents || [];

    if (objects.length === 0) {
      console.log('✅ No test files found. Already clean!');
      return;
    }

    console.log(`\n Found ${objects.length} test files:\n`);
    objects.forEach((obj, i) => {
      const size = obj.Size ? `(${formatSize(obj.Size)})` : '';
      console.log(`   ${i + 1}. ${obj.Key} ${size}`);
    });

    // Delete all objects
    console.log(`\n🗑️  Deleting ${objects.length} files...`);

    const deleteCommand = new DeleteObjectsCommand({
      Bucket: BUCKET,
      Delete: {
        Objects: objects.map(obj => ({ Key: obj.Key! })),
        Quiet: false,
      },
    });

    const deleteResult = await client.send(deleteCommand);

    console.log('\n✅ Cleanup complete!');
    console.log(`   Deleted: ${deleteResult.Deleted?.length || 0} files`);

    if (deleteResult.Errors && deleteResult.Errors.length > 0) {
      console.log(`   Errors: ${deleteResult.Errors.length}`);
      deleteResult.Errors.forEach(err => {
        console.error(`      ❌ ${err.Key}: ${err.Message}`);
      });
    }

  } catch (error) {
    console.error('\n❌ Cleanup failed:', (error as Error).message);
    process.exit(1);
  }
}

function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

// Run cleanup
cleanup().catch(console.error);
