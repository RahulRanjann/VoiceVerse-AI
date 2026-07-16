import {
  Body,
  Controller,
  Delete,
  Get,
  Headers,
  HttpCode,
  Param,
  Post,
  UseGuards,
} from '@nestjs/common';
import { ApiBearerAuth, ApiHeader, ApiOperation, ApiTags } from '@nestjs/swagger';

import type { AccessContext } from '../../identity/domain/access-context';
import { AccessTokenGuard } from '../../identity/presentation/access-token.guard';
import { CurrentAuth } from '../../identity/presentation/current-auth.decorator';
import { MediaIngestService } from '../application/media-ingest.service';
import {
  CompleteMultipartUploadDto,
  CreateMultipartUploadDto,
  SignPartsDto,
} from './media-ingest.dto';

@ApiTags('Media ingest')
@ApiBearerAuth()
@UseGuards(AccessTokenGuard)
@Controller({ version: '1' })
export class MediaIngestController {
  constructor(private readonly media: MediaIngestService) {}

  @Post('projects/:projectId/videos/multipart-uploads')
  @ApiHeader({ name: 'Idempotency-Key', required: true })
  @ApiOperation({ summary: 'Create a resumable direct-to-S3 MP4 upload.' })
  create(
    @CurrentAuth() context: AccessContext,
    @Param('projectId') projectId: string,
    @Headers('idempotency-key') idempotencyKey: string | undefined,
    @Body() input: CreateMultipartUploadDto,
  ) {
    return this.media.create(context, projectId, idempotencyKey ?? '', input);
  }

  @Post('multipart-uploads/:uploadId/parts/sign')
  @ApiOperation({ summary: 'Sign a bounded batch of multipart upload parts.' })
  signParts(
    @CurrentAuth() context: AccessContext,
    @Param('uploadId') uploadId: string,
    @Body() input: SignPartsDto,
  ) {
    return this.media.signParts(context, uploadId, input);
  }

  @Post('multipart-uploads/:uploadId/complete')
  @ApiOperation({ summary: 'Complete an upload and move the source into quarantine.' })
  complete(
    @CurrentAuth() context: AccessContext,
    @Param('uploadId') uploadId: string,
    @Body() input: CompleteMultipartUploadDto,
  ) {
    return this.media.complete(context, uploadId, input);
  }

  @Get('multipart-uploads/:uploadId')
  @ApiOperation({ summary: 'Get authoritative upload and quarantine state.' })
  status(@CurrentAuth() context: AccessContext, @Param('uploadId') uploadId: string) {
    return this.media.status(context, uploadId);
  }

  @Delete('multipart-uploads/:uploadId')
  @HttpCode(204)
  @ApiOperation({ summary: 'Abort an incomplete multipart upload.' })
  abort(@CurrentAuth() context: AccessContext, @Param('uploadId') uploadId: string) {
    return this.media.abort(context, uploadId);
  }
}
