import { Controller, Get, Header, Param, ParseUUIDPipe, Query, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiOkResponse, ApiOperation, ApiTags } from '@nestjs/swagger';

import type { AccessContext } from '../../identity/domain/access-context';
import { AccessTokenGuard } from '../../identity/presentation/access-token.guard';
import { CurrentAuth } from '../../identity/presentation/current-auth.decorator';
import { SpeechAnalysisQueryService } from '../application/speech-analysis-query.service';
import {
  CharacterResultPageDto,
  DialogueSegmentResultPageDto,
  ListSpeechAnalysisResultsQueryDto,
} from './speech-analysis-query.dto';

@ApiTags('Speech analysis')
@ApiBearerAuth()
@UseGuards(AccessTokenGuard)
@Controller({ path: 'jobs/:jobId', version: '1' })
export class SpeechAnalysisQueryController {
  constructor(private readonly queries: SpeechAnalysisQueryService) {}

  @Get('characters')
  @Header('Cache-Control', 'private, no-store')
  @ApiOperation({ summary: 'List committed characters detected by a speech-analysis job.' })
  @ApiOkResponse({ type: CharacterResultPageDto })
  listCharacters(
    @CurrentAuth() context: AccessContext,
    @Param('jobId', new ParseUUIDPipe()) jobId: string,
    @Query() query: ListSpeechAnalysisResultsQueryDto,
  ) {
    return this.queries.listCharacters(context, jobId, query);
  }

  @Get('dialogue-segments')
  @Header('Cache-Control', 'private, no-store')
  @ApiOperation({ summary: 'List committed, speaker-resolved source dialogue for a job.' })
  @ApiOkResponse({ type: DialogueSegmentResultPageDto })
  listDialogueSegments(
    @CurrentAuth() context: AccessContext,
    @Param('jobId', new ParseUUIDPipe()) jobId: string,
    @Query() query: ListSpeechAnalysisResultsQueryDto,
  ) {
    return this.queries.listDialogueSegments(context, jobId, query);
  }
}
