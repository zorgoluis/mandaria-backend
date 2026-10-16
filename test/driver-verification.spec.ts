import { describe, it, expect } from 'vitest';
import sharp from 'sharp';
import {
  validateImage,
  MAX_BYTES,
} from '../dist/verification/verification-storage.js';
import {
  parseData,
  categories,
  canonical,
} from '../dist/verification/verification-rules.js';
import { VerificationRuntime } from '../dist/verification/verification-policy.js';
import { ConfigService } from '@nestjs/config';
describe('Verification bounds and local-only policy', () => {
  it('rejects local test activation in production even if enabled', () => {
    expect(() =>
      new VerificationRuntime(
        new ConfigService({
          NODE_ENV: 'production',
          DRIVER_VERIFICATION_LOCAL_ENABLED: true,
        }),
      ).assertLocal(),
    ).toThrow('VERIFICATION_LOCAL_DISABLED');
  });
  it('rejects disabled runtime', () => {
    expect(() =>
      new VerificationRuntime(
        new ConfigService({
          NODE_ENV: 'test',
          DRIVER_VERIFICATION_LOCAL_ENABLED: false,
        }),
      ).assertLocal(),
    ).toThrow();
  });
  it('normalizes JPEG and removes metadata with server-computed hashes', async () => {
    const bytes = await sharp({
      create: { width: 20, height: 20, channels: 3, background: '#abc' },
    })
      .jpeg()
      .toBuffer();
    const result = await validateImage(bytes);
    expect(result.mime).toBe('image/png');
    expect(result.sourceHash).not.toBe(result.hash);
    expect((await sharp(result.body).metadata()).exif).toBeUndefined();
  });
  it('rejects oversize objects before decoding', async () => {
    await expect(validateImage(Buffer.alloc(MAX_BYTES + 1))).rejects.toThrow(
      'VERIFICATION_FILE_SIZE',
    );
  });
  it.each(['<svg></svg>', '<script>alert(1)</script>', '%PDF-1.7\nunsafe'])(
    'rejects unsupported document %s',
    async (text) => {
      await expect(validateImage(Buffer.from(text))).rejects.toThrow();
    },
  );
  it('does not confuse use evidence with property proof', () => {
    expect(categories(false, { ownershipEvidenceType: 'BORROWED' })).toEqual([
      'REGISTRATION_CARD',
      'OWNER_AUTHORIZATION',
    ]);
    expect(categories(false, { ownershipEvidenceType: 'RENTED' })).toEqual([
      'REGISTRATION_CARD',
      'RENTAL_CONTRACT',
    ]);
  });
  it('rejects unapproved license categories and extra fields', () => {
    expect(() =>
      parseData(true, {
        fullName: 'Synthetic',
        contactPhone: '00000',
        operatingCity: 'Test',
        documentType: 'INE',
        license: {
          issuer: 'X',
          category: 'X',
          expiresAt: '2028-01-01T00:00:00Z',
          vehicleTypes: ['OTHER'],
        },
      }),
    ).toThrow('VERIFICATION_DATA_INVALID');
  });
  it('canonicalizes nested objects consistently without changing array order', () => {
    expect(canonical({ a: 1, b: { d: 3, c: 2 } })).toBe(
      canonical({ b: { c: 2, d: 3 }, a: 1 }),
    );
    expect(canonical([1, 2])).not.toBe(canonical([2, 1]));
  });
});
import { S3Client, PutObjectCommand } from '@aws-sdk/client-s3';
import { Readable } from 'node:stream';
import { vi } from 'vitest';
import { SpacesVerificationStorage } from '../dist/verification/verification-storage.js';
describe('Spaces adapter protocol with SDK transport double (no external network)', () => {
  const adapter = () =>
    new SpacesVerificationStorage('synthetic-test-bucket', {
      endpoint: 'https://nyc3.digitaloceanspaces.com',
      accessKeyId: 'SYNTHETIC_KEY',
      secretAccessKey: 'synthetic-not-real-secret',
    });
  it('signs a private short-lived quarantine upload without a public ACL', async () => {
    const signed = new URL(
      await adapter().uploadUrl('verification/v1/quarantine/synthetic/source'),
    );
    expect(signed.hostname).toBe(
      'synthetic-test-bucket.nyc3.digitaloceanspaces.com',
    );
    expect(signed.searchParams.get('X-Amz-Expires')).toBe('300');
    expect(signed.searchParams.get('x-amz-acl')).toBe('private');
  });
  it('sets private ACL, no-store and PNG type on reviewed image writes', async () => {
    const send = vi
      .spyOn(S3Client.prototype, 'send')
      .mockImplementation(async () => ({}));
    try {
      await adapter().write(
        'verification/v1/synthetic/original',
        Buffer.from('synthetic'),
      );
      const command = send.mock.calls[0][0] as PutObjectCommand;
      expect(command.input).toMatchObject({
        ACL: 'private',
        CacheControl: 'no-store',
        ContentType: 'image/png',
      });
    } finally {
      send.mockRestore();
    }
  });
  it('bounds bytes actually received, independently of remote ContentLength', async () => {
    const stream = Readable.from([Buffer.alloc(MAX_BYTES + 1)]);
    const send = vi
      .spyOn(S3Client.prototype, 'send')
      .mockImplementation(async () => ({ ContentLength: 10, Body: stream }));
    try {
      await expect(adapter().read('verification/v1/synthetic')).rejects.toThrow(
        'VERIFICATION_FILE_SIZE',
      );
      expect(stream.destroyed).toBe(true);
    } finally {
      send.mockRestore();
    }
  });
  it('does not allow arbitrary storage endpoints', () => {
    expect(
      () =>
        new SpacesVerificationStorage('x', {
          endpoint: 'http://127.0.0.1',
          accessKeyId: 'x',
          secretAccessKey: 'x',
        }),
    ).toThrow('Invalid Spaces endpoint');
  });
});
