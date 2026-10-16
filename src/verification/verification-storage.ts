import {
  GetObjectCommand,
  PutObjectCommand,
  DeleteObjectCommand,
  S3Client,
} from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import sharp from 'sharp';
import { verificationError } from './verification-error.js';
import { digest } from './verification-rules.js';
export const VERIFICATION_STORAGE = Symbol('VERIFICATION_STORAGE');
export const MAX_BYTES = 10 * 1024 * 1024;
export interface VerificationStorage {
  uploadUrl(key: string): Promise<string>;
  read(key: string): Promise<Buffer>;
  write(key: string, body: Buffer): Promise<void>;
  remove(key: string): Promise<void>;
}
/** No production credentials or bucket discovery. The disabled adapter fails closed. */
export class DisabledVerificationStorage implements VerificationStorage {
  uploadUrl(): Promise<string> {
    return Promise.reject(new Error('STORAGE_UNAVAILABLE'));
  }
  read(): Promise<Buffer> {
    return Promise.reject(new Error('STORAGE_UNAVAILABLE'));
  }
  write(): Promise<void> {
    return Promise.reject(new Error('STORAGE_UNAVAILABLE'));
  }
  remove(): Promise<void> {
    return Promise.reject(new Error('STORAGE_UNAVAILABLE'));
  }
}
/** Private Spaces adapter; explicit credentials supplied by composition, never default AWS chain. */
export class SpacesVerificationStorage implements VerificationStorage {
  private readonly client: S3Client;
  constructor(
    private readonly bucket: string,
    settings: {
      endpoint: string;
      accessKeyId: string;
      secretAccessKey: string;
    },
  ) {
    if (
      !/^https:\/\/[a-z0-9-]+\.digitaloceanspaces\.com$/.test(settings.endpoint)
    )
      throw new Error('Invalid Spaces endpoint');
    this.client = new S3Client({
      endpoint: settings.endpoint,
      region: 'us-east-1',
      forcePathStyle: false,
      credentials: {
        accessKeyId: settings.accessKeyId,
        secretAccessKey: settings.secretAccessKey,
      },
      maxAttempts: 2,
    });
  }
  uploadUrl(key: string) {
    return getSignedUrl(
      this.client,
      new PutObjectCommand({
        Bucket: this.bucket,
        Key: key,
        ACL: 'private',
        ContentType: 'application/octet-stream',
      }),
      { expiresIn: 300 },
    );
  }
  async read(key: string) {
    const response = await this.client.send(
      new GetObjectCommand({ Bucket: this.bucket, Key: key }),
      { abortSignal: AbortSignal.timeout(15000) },
    );
    const body = response.Body;
    if (
      !body ||
      !response.ContentLength ||
      response.ContentLength > MAX_BYTES
    ) {
      if (body && 'destroy' in body) body.destroy();
      verificationError('VERIFICATION_FILE_SIZE', 413);
    }
    const chunks: Buffer[] = [];
    let bytes = 0;
    try {
      for await (const part of body as AsyncIterable<Uint8Array>) {
        bytes += part.length;
        if (bytes > MAX_BYTES) verificationError('VERIFICATION_FILE_SIZE', 413);
        chunks.push(Buffer.from(part));
      }
    } finally {
      if ('destroy' in body) body.destroy();
    }
    return Buffer.concat(chunks);
  }
  async write(key: string, body: Buffer) {
    await this.client.send(
      new PutObjectCommand({
        Bucket: this.bucket,
        Key: key,
        Body: body,
        ContentType: 'image/png',
        ACL: 'private',
        CacheControl: 'no-store',
      }),
      { abortSignal: AbortSignal.timeout(15000) },
    );
  }
  async remove(key: string) {
    await this.client.send(
      new DeleteObjectCommand({ Bucket: this.bucket, Key: key }),
      { abortSignal: AbortSignal.timeout(15000) },
    );
  }
}
/** Decode and re-encode raster images; deliberately not named CLEAN or malware scanned. */
export async function validateImage(body: Buffer) {
  if (!body.length || body.length > MAX_BYTES)
    verificationError('VERIFICATION_FILE_SIZE', 413);
  try {
    const image = sharp(body, {
      limitInputPixels: 20_000_000,
      failOn: 'warning',
      animated: false,
    });
    const meta = await image.metadata();
    if (!['png', 'jpeg'].includes(meta.format ?? '') || (meta.pages ?? 1) !== 1)
      verificationError('VERIFICATION_FILE_TYPE', 415);
    const normalized = await image.rotate().png().toBuffer();
    if (normalized.length > MAX_BYTES)
      verificationError('VERIFICATION_FILE_SIZE', 413);
    return {
      body: normalized,
      bytes: normalized.length,
      mime: 'image/png',
      hash: digest(normalized),
      sourceHash: digest(body),
    };
  } catch (error) {
    if (error instanceof Error && error.message.startsWith('VERIFICATION_'))
      throw error;
    verificationError('VERIFICATION_FILE_INVALID', 415);
  }
}
