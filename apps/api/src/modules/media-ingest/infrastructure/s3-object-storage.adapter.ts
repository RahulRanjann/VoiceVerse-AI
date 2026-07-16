import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import {
  AbortMultipartUploadCommand,
  CompleteMultipartUploadCommand,
  CreateMultipartUploadCommand,
  GetObjectCommand,
  HeadBucketCommand,
  HeadObjectCommand,
  S3Client,
  UploadPartCommand,
  type CompletedPart,
  type ServerSideEncryption,
} from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';

import type { Environment } from '../../../config/environment';
import type {
  CompleteMultipartObject,
  CreateMultipartObject,
  ObjectStoragePort,
  SignMultipartPart,
  StoredObjectMetadata,
} from '../domain/object-storage.port';

@Injectable()
export class S3ObjectStorageAdapter implements ObjectStoragePort {
  private readonly internalClient: S3Client;
  private readonly signingClient: S3Client;
  private readonly signedUrlTtl: number;
  private readonly encryption?: ServerSideEncryption;
  private readonly kmsKeyId?: string;

  constructor(config: ConfigService<Environment, true>) {
    const credentials = {
      accessKeyId: config.get('S3_ACCESS_KEY', { infer: true }),
      secretAccessKey: config.get('S3_SECRET_KEY', { infer: true }),
    };
    const shared = {
      credentials,
      forcePathStyle: config.get('S3_FORCE_PATH_STYLE', { infer: true }),
      region: config.get('S3_REGION', { infer: true }),
    };
    this.internalClient = new S3Client({
      ...shared,
      endpoint: config.get('S3_ENDPOINT', { infer: true }),
    });
    this.signingClient = new S3Client({
      ...shared,
      endpoint: config.get('S3_PUBLIC_ENDPOINT', { infer: true }),
    });
    this.signedUrlTtl = config.get('S3_SIGNED_URL_TTL_SECONDS', { infer: true });
    const configuredEncryption = config.get('S3_SSE_ALGORITHM', { infer: true });
    this.encryption = configuredEncryption === 'none' ? undefined : configuredEncryption;
    this.kmsKeyId = config.get('S3_KMS_KEY_ID', { infer: true });
  }

  async ping(bucket: string): Promise<void> {
    await this.internalClient.send(new HeadBucketCommand({ Bucket: bucket }));
  }

  async createMultipartUpload(input: CreateMultipartObject): Promise<string> {
    const result = await this.internalClient.send(
      new CreateMultipartUploadCommand({
        Bucket: input.bucket,
        ContentType: input.mediaType,
        Key: input.key,
        Metadata: input.metadata,
        ServerSideEncryption: this.encryption,
        SSEKMSKeyId: this.encryption === 'aws:kms' ? this.kmsKeyId : undefined,
      }),
    );
    if (!result.UploadId) throw new Error('Object storage did not return a multipart upload ID.');
    return result.UploadId;
  }

  signUploadPart(input: SignMultipartPart): Promise<string> {
    return getSignedUrl(
      this.signingClient,
      new UploadPartCommand({
        Bucket: input.bucket,
        ContentLength: input.contentLength,
        Key: input.key,
        PartNumber: input.partNumber,
        UploadId: input.providerUploadId,
      }),
      { expiresIn: this.signedUrlTtl },
    );
  }

  async completeMultipartUpload(input: CompleteMultipartObject): Promise<{ etag?: string }> {
    const parts: CompletedPart[] = input.parts.map((part) => ({
      ETag: part.etag,
      PartNumber: part.partNumber,
    }));
    const result = await this.internalClient.send(
      new CompleteMultipartUploadCommand({
        Bucket: input.bucket,
        Key: input.key,
        MultipartUpload: { Parts: parts },
        UploadId: input.providerUploadId,
      }),
    );
    return { etag: result.ETag };
  }

  async abortMultipartUpload(input: {
    bucket: string;
    key: string;
    providerUploadId: string;
  }): Promise<void> {
    await this.internalClient.send(
      new AbortMultipartUploadCommand({
        Bucket: input.bucket,
        Key: input.key,
        UploadId: input.providerUploadId,
      }),
    );
  }

  async headObject(input: { bucket: string; key: string }): Promise<StoredObjectMetadata> {
    const result = await this.internalClient.send(
      new HeadObjectCommand({ Bucket: input.bucket, Key: input.key }),
    );
    if (result.ContentLength === undefined) {
      throw new Error('Object storage did not return object length.');
    }
    return { byteSize: result.ContentLength, etag: result.ETag };
  }

  async getObjectStream(input: {
    bucket: string;
    key: string;
  }): Promise<AsyncIterable<Uint8Array>> {
    const result = await this.internalClient.send(
      new GetObjectCommand({ Bucket: input.bucket, Key: input.key }),
    );
    const body = result.Body;
    if (!body || !(Symbol.asyncIterator in body)) {
      throw new Error('Object storage response was not streamable.');
    }
    return body as AsyncIterable<Uint8Array>;
  }
}
