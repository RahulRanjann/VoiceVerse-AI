import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  HttpStatus,
  Inject,
  Injectable,
  Logger,
  NotFoundException,
  ServiceUnavailableException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import {
  MediaSecurityStatus,
  MultipartUploadStatus,
  OrganizationRole,
  OutboxStatus,
  ProjectStatus,
  VideoIngestStatus,
} from '@voiceverse/database';

import type { Environment } from '../../../config/environment';
import { DatabaseService } from '../../../infrastructure/database/database.service';
import { uuidv7 } from '../../../shared/uuid';
import type { AccessContext } from '../../identity/domain/access-context';
import {
  OBJECT_STORAGE_UNAVAILABLE_CODE,
  OBJECT_STORAGE_UNAVAILABLE_MESSAGE,
  ObjectStorageUnavailableError,
  type ObjectStorageOperation,
} from '../domain/object-storage.error';
import {
  OBJECT_STORAGE,
  type ObjectStoragePort,
  type StoredObjectMetadata,
} from '../domain/object-storage.port';
import type {
  CompleteMultipartUploadDto,
  CreateMultipartUploadDto,
  SignPartsDto,
} from '../presentation/media-ingest.dto';

const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const idempotencyPattern = /^[A-Za-z0-9][A-Za-z0-9._:-]{7,127}$/;

function isUniqueConstraintViolation(error: unknown): boolean {
  return typeof error === 'object' && error !== null && 'code' in error && error.code === 'P2002';
}

@Injectable()
export class MediaIngestService {
  private readonly logger = new Logger(MediaIngestService.name);
  private readonly bucket: string;
  private readonly partSize: number;
  private readonly maxUploadBytes: number;
  private readonly uploadExpiryHours: number;
  private readonly signedUrlTtlSeconds: number;

  constructor(
    private readonly database: DatabaseService,
    private readonly config: ConfigService<Environment, true>,
    @Inject(OBJECT_STORAGE) private readonly storage: ObjectStoragePort,
  ) {
    this.bucket = config.get('S3_BUCKET', { infer: true });
    this.partSize = config.get('S3_PART_SIZE_BYTES', { infer: true });
    this.maxUploadBytes = config.get('UPLOAD_MAX_BYTES', { infer: true });
    this.uploadExpiryHours = config.get('S3_MULTIPART_EXPIRY_HOURS', { infer: true });
    this.signedUrlTtlSeconds = config.get('S3_SIGNED_URL_TTL_SECONDS', { infer: true });
  }

  async create(
    context: AccessContext,
    projectId: string,
    idempotencyKey: string,
    input: CreateMultipartUploadDto,
  ) {
    this.assertCanEdit(context);
    this.assertUuid(projectId, 'project');
    if (!idempotencyPattern.test(idempotencyKey)) {
      throw new BadRequestException('Idempotency-Key must be 8-128 safe ASCII characters.');
    }
    const normalized = this.normalizeUpload(input);

    const existing = await this.database.client.multipartUpload.findUnique({
      include: { video: true },
      where: {
        organizationId_idempotencyKey: {
          idempotencyKey,
          organizationId: context.organizationId,
        },
      },
    });
    if (existing) {
      this.assertIdempotentCreateMatches(existing.video, projectId, normalized);
      return this.toUploadResponse(existing, existing.video);
    }

    const project = await this.database.client.project.findFirst({
      select: { id: true, status: true, videos: { select: { id: true }, take: 1 } },
      where: { id: projectId, organizationId: context.organizationId },
    });
    if (!project) throw new NotFoundException('Project not found.');
    if (project.status === ProjectStatus.ARCHIVED) {
      throw new ConflictException('Archived projects cannot accept new media.');
    }
    if (project.videos.length > 0) {
      throw new ConflictException(
        'This project already has a source video. Create a new project for another movie.',
      );
    }

    const videoId = uuidv7();
    const uploadId = uuidv7();
    const totalParts = Math.ceil(normalized.byteSize / this.partSize);
    if (totalParts > 10_000) {
      throw new BadRequestException('The file exceeds the multipart part-count limit.');
    }
    const storageKey = `tenants/${context.organizationId}/projects/${projectId}/source/${videoId}/original.mp4`;
    let providerUploadId: string;
    try {
      providerUploadId = await this.storage.createMultipartUpload({
        bucket: this.bucket,
        key: storageKey,
        mediaType: normalized.mediaType,
        metadata: {
          'organization-id': context.organizationId,
          'project-id': projectId,
          'video-id': videoId,
        },
      });
    } catch (error) {
      throw this.objectStorageUnavailable(error, 'create-multipart-upload');
    }

    try {
      const created = await this.database.client.$transaction(async (transaction) => {
        const video = await transaction.video.create({
          data: {
            byteSize: BigInt(normalized.byteSize),
            createdByUserId: context.userId,
            id: videoId,
            ingestStatus: VideoIngestStatus.UPLOADING,
            mediaType: normalized.mediaType,
            organizationId: context.organizationId,
            originalFilename: normalized.filename,
            projectId,
            securityStatus: MediaSecurityStatus.PENDING,
            sha256: normalized.sha256,
            storageBucket: this.bucket,
            storageKey,
          },
        });
        const upload = await transaction.multipartUpload.create({
          data: {
            expiresAt: new Date(Date.now() + this.uploadExpiryHours * 3_600_000),
            id: uploadId,
            idempotencyKey,
            organizationId: context.organizationId,
            partSize: this.partSize,
            providerUploadId,
            status: MultipartUploadStatus.INITIATED,
            totalParts,
            videoId,
          },
        });
        await transaction.project.update({
          data: { status: ProjectStatus.INGESTING },
          where: { id: projectId },
        });
        await transaction.auditLog.create({
          data: {
            action: 'media.multipart_upload.created',
            actorUserId: context.userId,
            id: uuidv7(),
            organizationId: context.organizationId,
            resourceId: uploadId,
            resourceType: 'multipart_upload',
          },
        });
        return { upload, video };
      });
      return this.toUploadResponse(created.upload, created.video);
    } catch (error) {
      await this.bestEffortAbort(providerUploadId, storageKey);
      const winner = await this.database.client.multipartUpload.findUnique({
        include: { video: true },
        where: {
          organizationId_idempotencyKey: {
            idempotencyKey,
            organizationId: context.organizationId,
          },
        },
      });
      if (winner) {
        this.assertIdempotentCreateMatches(winner.video, projectId, normalized);
        return this.toUploadResponse(winner, winner.video);
      }
      if (isUniqueConstraintViolation(error)) {
        throw new ConflictException(
          'This project already has a source video. Create a new project for another movie.',
        );
      }
      throw error;
    }
  }

  async signParts(context: AccessContext, uploadId: string, input: SignPartsDto) {
    const upload = await this.ownedUpload(context, uploadId);
    this.assertUploadAcceptsParts(upload);
    for (const partNumber of input.partNumbers) {
      if (partNumber > upload.totalParts) {
        throw new BadRequestException(`Part ${partNumber} exceeds the upload part count.`);
      }
    }

    return {
      expiresInSeconds: this.signedUrlTtlSeconds,
      parts: await Promise.all(
        input.partNumbers.map(async (partNumber) => {
          const contentLength = this.expectedPartSize(
            Number(upload.video.byteSize),
            upload.partSize,
            upload.totalParts,
            partNumber,
          );
          return {
            contentLength,
            partNumber,
            url: await this.storage.signUploadPart({
              bucket: upload.video.storageBucket,
              contentLength,
              key: upload.video.storageKey,
              partNumber,
              providerUploadId: upload.providerUploadId,
            }),
          };
        }),
      ),
    };
  }

  async complete(context: AccessContext, uploadId: string, input: CompleteMultipartUploadDto) {
    const upload = await this.ownedUpload(context, uploadId);
    if (upload.status === MultipartUploadStatus.COMPLETED) {
      return this.toUploadResponse(upload, upload.video);
    }
    this.assertUploadAcceptsParts(upload, true);
    const parts = [...input.parts].sort((left, right) => left.partNumber - right.partNumber);
    this.assertCompleteManifest(
      parts,
      upload.totalParts,
      Number(upload.video.byteSize),
      upload.partSize,
    );

    await this.persistCompletionManifest(upload.id, parts);

    let completion: { etag?: string } = {};
    let stored: StoredObjectMetadata;
    try {
      completion = await this.storage.completeMultipartUpload({
        bucket: upload.video.storageBucket,
        key: upload.video.storageKey,
        parts,
        providerUploadId: upload.providerUploadId,
      });
      stored = await this.storage.headObject({
        bucket: upload.video.storageBucket,
        key: upload.video.storageKey,
      });
    } catch (completionError) {
      // CompleteMultipartUpload has an ambiguous-result window. A successful HEAD
      // reconciles a server-side completion whose response was lost.
      this.logObjectStorageFailure(completionError, 'complete-multipart-upload');
      try {
        stored = await this.storage.headObject({
          bucket: upload.video.storageBucket,
          key: upload.video.storageKey,
        });
      } catch (reconciliationError) {
        throw this.objectStorageUnavailable(reconciliationError, 'head-object');
      }
    }

    if (stored.byteSize !== Number(upload.video.byteSize)) {
      await this.database.client.$transaction([
        this.database.client.multipartUpload.update({
          data: { status: MultipartUploadStatus.FAILED },
          where: { id: upload.id },
        }),
        this.database.client.video.update({
          data: { ingestStatus: VideoIngestStatus.FAILED },
          where: { id: upload.video.id },
        }),
      ]);
      throw new ConflictException('The stored object size does not match the upload intent.');
    }

    const completed = await this.finalizeUpload(context, upload, completion.etag ?? stored.etag);
    return this.toUploadResponse(completed.upload, completed.video);
  }

  async status(context: AccessContext, uploadId: string) {
    const upload = await this.ownedUpload(context, uploadId);
    return this.toUploadResponse(upload, upload.video);
  }

  async abort(context: AccessContext, uploadId: string): Promise<void> {
    const upload = await this.ownedUpload(context, uploadId);
    if (upload.status === MultipartUploadStatus.ABORTED) return;
    if (upload.status === MultipartUploadStatus.COMPLETED) {
      throw new ConflictException('A completed upload cannot be aborted.');
    }
    await this.bestEffortAbort(upload.providerUploadId, upload.video.storageKey);
    await this.database.client.$transaction([
      this.database.client.multipartUpload.update({
        data: { abortedAt: new Date(), status: MultipartUploadStatus.ABORTED },
        where: { id: upload.id },
      }),
      this.database.client.video.update({
        data: { ingestStatus: VideoIngestStatus.ABORTED },
        where: { id: upload.video.id },
      }),
      this.database.client.auditLog.create({
        data: {
          action: 'media.multipart_upload.aborted',
          actorUserId: context.userId,
          id: uuidv7(),
          organizationId: context.organizationId,
          resourceId: upload.id,
          resourceType: 'multipart_upload',
        },
      }),
    ]);
  }

  private async persistCompletionManifest(
    uploadId: string,
    parts: CompleteMultipartUploadDto['parts'],
  ): Promise<void> {
    await this.database.client.$transaction(async (transaction) => {
      await transaction.$queryRaw`SELECT id FROM multipart_uploads WHERE id = ${uploadId}::uuid FOR UPDATE`;
      const current = await transaction.multipartUpload.findUniqueOrThrow({
        include: { parts: { orderBy: { partNumber: 'asc' } } },
        where: { id: uploadId },
      });
      if (current.status === MultipartUploadStatus.COMPLETED) return;
      if (current.parts.length > 0) {
        const matches = current.parts.every((persisted, index) => {
          const supplied = parts[index];
          return supplied?.partNumber === persisted.partNumber && supplied.etag === persisted.etag;
        });
        if (!matches || current.parts.length !== parts.length) {
          throw new ConflictException(
            'The completion manifest differs from the persisted manifest.',
          );
        }
      } else {
        await transaction.multipartUploadPart.createMany({
          data: parts.map((part) => ({
            byteSize: part.byteSize ? BigInt(part.byteSize) : undefined,
            checksumSha256: part.checksumSha256,
            etag: part.etag,
            id: uuidv7(),
            multipartUploadId: uploadId,
            partNumber: part.partNumber,
          })),
        });
      }
      await transaction.multipartUpload.update({
        data: { status: MultipartUploadStatus.COMPLETING },
        where: { id: uploadId },
      });
    });
  }

  private async finalizeUpload(
    context: AccessContext,
    upload: Awaited<ReturnType<MediaIngestService['ownedUpload']>>,
    storageEtag: string | undefined,
  ) {
    const now = new Date();
    return this.database.client.$transaction(async (transaction) => {
      const completedUpload = await transaction.multipartUpload.update({
        data: { completedAt: now, status: MultipartUploadStatus.COMPLETED },
        where: { id: upload.id },
      });
      const video = await transaction.video.update({
        data: {
          ingestStatus: VideoIngestStatus.UPLOADED,
          securityStatus: MediaSecurityStatus.PENDING,
          storageEtag,
          uploadedAt: now,
        },
        where: { id: upload.video.id },
      });
      const scan = await transaction.malwareScanAttempt.upsert({
        create: {
          attemptNumber: 1,
          engine: 'clamav',
          id: uuidv7(),
          status: 'QUEUED',
          videoId: video.id,
        },
        update: {},
        where: { videoId_attemptNumber: { attemptNumber: 1, videoId: video.id } },
      });
      await transaction.outboxEvent.upsert({
        create: {
          aggregateId: video.id,
          aggregateType: 'video',
          deduplicationKey: `media.scan.requested:${video.id}:1`,
          eventType: 'media.scan.requested',
          id: uuidv7(),
          organizationId: context.organizationId,
          payload: {
            attemptId: scan.id,
            bucket: video.storageBucket,
            key: video.storageKey,
            organizationId: context.organizationId,
            videoId: video.id,
          },
          status: OutboxStatus.PENDING,
        },
        update: {},
        where: { deduplicationKey: `media.scan.requested:${video.id}:1` },
      });
      await transaction.auditLog.create({
        data: {
          action: 'media.multipart_upload.completed',
          actorUserId: context.userId,
          id: uuidv7(),
          organizationId: context.organizationId,
          resourceId: upload.id,
          resourceType: 'multipart_upload',
        },
      });
      return { upload: completedUpload, video };
    });
  }

  private async ownedUpload(context: AccessContext, uploadId: string) {
    this.assertUuid(uploadId, 'upload');
    const upload = await this.database.client.multipartUpload.findFirst({
      include: { video: true },
      where: { id: uploadId, organizationId: context.organizationId },
    });
    if (!upload) throw new NotFoundException('Multipart upload not found.');
    return upload;
  }

  private normalizeUpload(input: CreateMultipartUploadDto) {
    const filename = input.filename.normalize('NFC').trim();
    const containsControlCharacter = Array.from(filename).some((character) => {
      const codePoint = character.codePointAt(0);
      return codePoint !== undefined && (codePoint < 32 || codePoint === 127);
    });
    if (
      !filename ||
      filename.includes('/') ||
      filename.includes('\\') ||
      containsControlCharacter
    ) {
      throw new BadRequestException('The source filename is invalid.');
    }
    if (input.mediaType.toLowerCase() !== 'video/mp4') {
      throw new BadRequestException('Milestone 1 accepts MP4 video only.');
    }
    if (input.byteSize > this.maxUploadBytes) {
      throw new BadRequestException('The source file exceeds the configured upload limit.');
    }
    return {
      byteSize: input.byteSize,
      filename,
      mediaType: 'video/mp4',
      sha256: input.sha256,
    };
  }

  private assertIdempotentCreateMatches(
    video: { projectId: string; originalFilename: string; byteSize: bigint; sha256: string | null },
    projectId: string,
    input: ReturnType<MediaIngestService['normalizeUpload']>,
  ): void {
    if (
      video.projectId !== projectId ||
      video.originalFilename !== input.filename ||
      Number(video.byteSize) !== input.byteSize ||
      (video.sha256 ?? undefined) !== input.sha256
    ) {
      throw new ConflictException('The Idempotency-Key was already used for another upload.');
    }
  }

  private assertUploadAcceptsParts(
    upload: { status: MultipartUploadStatus; expiresAt: Date },
    allowCompleting = false,
  ): void {
    const allowed =
      upload.status === MultipartUploadStatus.INITIATED ||
      (allowCompleting && upload.status === MultipartUploadStatus.COMPLETING);
    if (!allowed) throw new ConflictException('The multipart upload is no longer writable.');
    if (upload.expiresAt <= new Date())
      throw new ConflictException('The multipart upload expired.');
  }

  private assertCompleteManifest(
    parts: CompleteMultipartUploadDto['parts'],
    totalParts: number,
    totalBytes: number,
    partSize: number,
  ): void {
    if (parts.length !== totalParts) {
      throw new BadRequestException('Every multipart part must be present at completion.');
    }
    parts.forEach((part, index) => {
      const expectedPartNumber = index + 1;
      if (part.partNumber !== expectedPartNumber) {
        throw new BadRequestException('Multipart part numbers must be unique and contiguous.');
      }
      const expectedBytes = this.expectedPartSize(
        totalBytes,
        partSize,
        totalParts,
        part.partNumber,
      );
      if (part.byteSize !== undefined && part.byteSize !== expectedBytes) {
        throw new BadRequestException(`Part ${part.partNumber} has an unexpected byte size.`);
      }
    });
  }

  private expectedPartSize(
    totalBytes: number,
    partSize: number,
    totalParts: number,
    partNumber: number,
  ): number {
    return partNumber === totalParts ? totalBytes - partSize * (totalParts - 1) : partSize;
  }

  private toUploadResponse(
    upload: {
      id: string;
      status: MultipartUploadStatus;
      partSize: number;
      totalParts: number;
      expiresAt: Date;
      completedAt: Date | null;
      abortedAt: Date | null;
    },
    video: {
      id: string;
      projectId: string;
      originalFilename: string;
      mediaType: string;
      byteSize: bigint;
      ingestStatus: VideoIngestStatus;
      securityStatus: MediaSecurityStatus;
    },
  ) {
    return {
      abortedAt: upload.abortedAt?.toISOString() ?? null,
      completedAt: upload.completedAt?.toISOString() ?? null,
      expiresAt: upload.expiresAt.toISOString(),
      id: upload.id,
      partSize: upload.partSize,
      status: upload.status,
      totalParts: upload.totalParts,
      video: {
        byteSize: video.byteSize.toString(),
        id: video.id,
        ingestStatus: video.ingestStatus,
        mediaType: video.mediaType,
        originalFilename: video.originalFilename,
        projectId: video.projectId,
        securityStatus: video.securityStatus,
      },
    };
  }

  private assertCanEdit(context: AccessContext): void {
    if (context.role === OrganizationRole.VIEWER) {
      throw new ForbiddenException('This organization role cannot upload media.');
    }
  }

  private assertUuid(value: string, resource: string): void {
    if (!uuidPattern.test(value)) throw new BadRequestException(`The ${resource} ID is invalid.`);
  }

  private async bestEffortAbort(providerUploadId: string, key: string): Promise<void> {
    try {
      await this.storage.abortMultipartUpload({
        bucket: this.bucket,
        key,
        providerUploadId,
      });
    } catch {
      // Lifecycle expiration is the final cleanup safety net. This path must not
      // replace the primary database/storage error with an abort error.
    }
  }

  private objectStorageUnavailable(
    error: unknown,
    fallbackOperation: ObjectStorageOperation,
  ): ServiceUnavailableException {
    this.logObjectStorageFailure(error, fallbackOperation);
    return new ServiceUnavailableException({
      code: OBJECT_STORAGE_UNAVAILABLE_CODE,
      message: OBJECT_STORAGE_UNAVAILABLE_MESSAGE,
      statusCode: HttpStatus.SERVICE_UNAVAILABLE,
    });
  }

  private logObjectStorageFailure(error: unknown, fallbackOperation: ObjectStorageOperation): void {
    const storageError =
      error instanceof ObjectStorageUnavailableError
        ? error
        : new ObjectStorageUnavailableError(fallbackOperation, error);
    const causeName =
      storageError.cause instanceof Error ? storageError.cause.name : 'UnknownError';
    this.logger.warn(
      {
        dependency: 'object-storage',
        errorCode: storageError.code,
        errorName: causeName,
        operation: storageError.operation,
      },
      'Object storage operation unavailable',
    );
  }
}
