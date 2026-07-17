import {
  Body,
  Controller,
  Get,
  Header,
  Headers,
  Param,
  Patch,
  Post,
  Query,
  UseGuards,
} from '@nestjs/common';
import { ApiBearerAuth, ApiHeader, ApiOperation, ApiTags } from '@nestjs/swagger';

import type { AccessContext } from '../../identity/domain/access-context';
import { AccessTokenGuard } from '../../identity/presentation/access-token.guard';
import { CurrentAuth } from '../../identity/presentation/current-auth.decorator';
import { LocalizationService } from '../application/localization.service';
import {
  CreateGlossaryEntryDto,
  CreateLocalizationTrackDto,
  GenerateSceneTranslationDto,
  ListLocalizationHistoryQueryDto,
  ListLocalizationScenesQueryDto,
  SelectLocalizationRevisionDto,
  UpdateGlossaryRevisionDto,
  UpdateSceneRevisionDto,
  UpdateSourceDialogueRevisionDto,
  UpdateTranslationRevisionDto,
  UpdateTranslationStateDto,
} from './localization.dto';

@ApiTags('Localization')
@ApiBearerAuth()
@UseGuards(AccessTokenGuard)
@Controller({ path: 'projects/:projectId/localization-tracks', version: '1' })
export class LocalizationController {
  constructor(private readonly localization: LocalizationService) {}

  @Get()
  @Header('Cache-Control', 'private, no-store')
  @ApiOperation({ summary: 'List localization tracks for a project.' })
  listTracks(@CurrentAuth() context: AccessContext, @Param('projectId') projectId: string) {
    return this.localization.listTracks(context, projectId);
  }

  @Post()
  @Header('Cache-Control', 'private, no-store')
  @ApiOperation({ summary: 'Open a target-language localization track.' })
  createTrack(
    @CurrentAuth() context: AccessContext,
    @Param('projectId') projectId: string,
    @Body() input: CreateLocalizationTrackDto,
  ) {
    return this.localization.createTrack(context, projectId, input);
  }

  @Get(':trackId/scenes')
  @Header('Cache-Control', 'private, no-store')
  @ApiOperation({ summary: 'List active localization scenes and bounded dialogues.' })
  listScenes(
    @CurrentAuth() context: AccessContext,
    @Param('projectId') projectId: string,
    @Param('trackId') trackId: string,
    @Query() query: ListLocalizationScenesQueryDto,
  ) {
    return this.localization.listScenes(context, projectId, trackId, query);
  }

  @Patch(':trackId/scenes/:sceneId')
  @Header('Cache-Control', 'private, no-store')
  @ApiOperation({ summary: 'Append and select an editorial scene revision.' })
  updateScene(
    @CurrentAuth() context: AccessContext,
    @Param('projectId') projectId: string,
    @Param('trackId') trackId: string,
    @Param('sceneId') sceneId: string,
    @Body() input: UpdateSceneRevisionDto,
  ) {
    return this.localization.updateScene(context, projectId, trackId, sceneId, input);
  }

  @Get(':trackId/scenes/:sceneId/revisions')
  @Header('Cache-Control', 'private, no-store')
  @ApiOperation({ summary: 'List immutable scene revision history.' })
  listSceneRevisions(
    @CurrentAuth() context: AccessContext,
    @Param('projectId') projectId: string,
    @Param('trackId') trackId: string,
    @Param('sceneId') sceneId: string,
    @Query() query: ListLocalizationHistoryQueryDto,
  ) {
    return this.localization.listSceneRevisions(context, projectId, trackId, sceneId, query);
  }

  @Post(':trackId/scenes/:sceneId/selection')
  @Header('Cache-Control', 'private, no-store')
  @ApiOperation({ summary: 'Select a historical scene revision.' })
  selectSceneRevision(
    @CurrentAuth() context: AccessContext,
    @Param('projectId') projectId: string,
    @Param('trackId') trackId: string,
    @Param('sceneId') sceneId: string,
    @Body() input: SelectLocalizationRevisionDto,
  ) {
    return this.localization.selectSceneRevision(context, projectId, trackId, sceneId, input);
  }

  @Patch(':trackId/dialogues/:dialogueId/source')
  @Header('Cache-Control', 'private, no-store')
  @ApiOperation({ summary: 'Append and select a source-dialogue revision.' })
  updateSourceDialogue(
    @CurrentAuth() context: AccessContext,
    @Param('projectId') projectId: string,
    @Param('trackId') trackId: string,
    @Param('dialogueId') dialogueId: string,
    @Body() input: UpdateSourceDialogueRevisionDto,
  ) {
    return this.localization.updateSourceDialogue(context, projectId, trackId, dialogueId, input);
  }

  @Get(':trackId/dialogues/:dialogueId/source/revisions')
  @Header('Cache-Control', 'private, no-store')
  @ApiOperation({ summary: 'List immutable source-dialogue revision history.' })
  listSourceRevisions(
    @CurrentAuth() context: AccessContext,
    @Param('projectId') projectId: string,
    @Param('trackId') trackId: string,
    @Param('dialogueId') dialogueId: string,
    @Query() query: ListLocalizationHistoryQueryDto,
  ) {
    return this.localization.listSourceRevisions(context, projectId, trackId, dialogueId, query);
  }

  @Post(':trackId/dialogues/:dialogueId/source/selection')
  @Header('Cache-Control', 'private, no-store')
  @ApiOperation({ summary: 'Select a historical source-dialogue revision.' })
  selectSourceRevision(
    @CurrentAuth() context: AccessContext,
    @Param('projectId') projectId: string,
    @Param('trackId') trackId: string,
    @Param('dialogueId') dialogueId: string,
    @Body() input: SelectLocalizationRevisionDto,
  ) {
    return this.localization.selectSourceRevision(context, projectId, trackId, dialogueId, input);
  }

  @Patch(':trackId/dialogues/:dialogueId/translation')
  @Header('Cache-Control', 'private, no-store')
  @ApiOperation({ summary: 'Append and select a manual translation revision.' })
  updateTranslation(
    @CurrentAuth() context: AccessContext,
    @Param('projectId') projectId: string,
    @Param('trackId') trackId: string,
    @Param('dialogueId') dialogueId: string,
    @Body() input: UpdateTranslationRevisionDto,
  ) {
    return this.localization.updateTranslation(context, projectId, trackId, dialogueId, input);
  }

  @Get(':trackId/dialogues/:dialogueId/translation/revisions')
  @Header('Cache-Control', 'private, no-store')
  @ApiOperation({ summary: 'List immutable translation revision history.' })
  listTranslationRevisions(
    @CurrentAuth() context: AccessContext,
    @Param('projectId') projectId: string,
    @Param('trackId') trackId: string,
    @Param('dialogueId') dialogueId: string,
    @Query() query: ListLocalizationHistoryQueryDto,
  ) {
    return this.localization.listTranslationRevisions(
      context,
      projectId,
      trackId,
      dialogueId,
      query,
    );
  }

  @Patch(':trackId/dialogues/:dialogueId/translation/state')
  @Header('Cache-Control', 'private, no-store')
  @ApiOperation({ summary: 'Move a translation through the editorial review workflow.' })
  updateTranslationState(
    @CurrentAuth() context: AccessContext,
    @Param('projectId') projectId: string,
    @Param('trackId') trackId: string,
    @Param('dialogueId') dialogueId: string,
    @Body() input: UpdateTranslationStateDto,
  ) {
    return this.localization.updateTranslationState(context, projectId, trackId, dialogueId, input);
  }

  @Post(':trackId/dialogues/:dialogueId/translation/selection')
  @Header('Cache-Control', 'private, no-store')
  @ApiOperation({ summary: 'Select a historical translation revision.' })
  selectTranslationRevision(
    @CurrentAuth() context: AccessContext,
    @Param('projectId') projectId: string,
    @Param('trackId') trackId: string,
    @Param('dialogueId') dialogueId: string,
    @Body() input: SelectLocalizationRevisionDto,
  ) {
    return this.localization.selectTranslationRevision(
      context,
      projectId,
      trackId,
      dialogueId,
      input,
    );
  }

  @Get(':trackId/glossary')
  @Header('Cache-Control', 'private, no-store')
  @ApiOperation({ summary: 'List the active track glossary.' })
  listGlossary(
    @CurrentAuth() context: AccessContext,
    @Param('projectId') projectId: string,
    @Param('trackId') trackId: string,
  ) {
    return this.localization.listGlossary(context, projectId, trackId);
  }

  @Post(':trackId/glossary')
  @Header('Cache-Control', 'private, no-store')
  @ApiOperation({ summary: 'Create a versioned glossary entry.' })
  createGlossaryEntry(
    @CurrentAuth() context: AccessContext,
    @Param('projectId') projectId: string,
    @Param('trackId') trackId: string,
    @Body() input: CreateGlossaryEntryDto,
  ) {
    return this.localization.createGlossaryEntry(context, projectId, trackId, input);
  }

  @Patch(':trackId/glossary/:entryId')
  @Header('Cache-Control', 'private, no-store')
  @ApiOperation({ summary: 'Append and select a glossary revision.' })
  updateGlossaryEntry(
    @CurrentAuth() context: AccessContext,
    @Param('projectId') projectId: string,
    @Param('trackId') trackId: string,
    @Param('entryId') entryId: string,
    @Body() input: UpdateGlossaryRevisionDto,
  ) {
    return this.localization.updateGlossaryEntry(context, projectId, trackId, entryId, input);
  }

  @Get(':trackId/glossary/:entryId/revisions')
  @Header('Cache-Control', 'private, no-store')
  @ApiOperation({ summary: 'List immutable glossary revision history.' })
  listGlossaryRevisions(
    @CurrentAuth() context: AccessContext,
    @Param('projectId') projectId: string,
    @Param('trackId') trackId: string,
    @Param('entryId') entryId: string,
    @Query() query: ListLocalizationHistoryQueryDto,
  ) {
    return this.localization.listGlossaryRevisions(context, projectId, trackId, entryId, query);
  }

  @Post(':trackId/glossary/:entryId/selection')
  @Header('Cache-Control', 'private, no-store')
  @ApiOperation({ summary: 'Select a historical glossary revision.' })
  selectGlossaryRevision(
    @CurrentAuth() context: AccessContext,
    @Param('projectId') projectId: string,
    @Param('trackId') trackId: string,
    @Param('entryId') entryId: string,
    @Body() input: SelectLocalizationRevisionDto,
  ) {
    return this.localization.selectGlossaryRevision(context, projectId, trackId, entryId, input);
  }

  @Post(':trackId/generations')
  @Header('Cache-Control', 'private, no-store')
  @ApiHeader({ name: 'Idempotency-Key', required: true })
  @ApiOperation({ summary: 'Queue translation generation for an exact scene snapshot.' })
  createGeneration(
    @CurrentAuth() context: AccessContext,
    @Param('projectId') projectId: string,
    @Param('trackId') trackId: string,
    @Headers('idempotency-key') idempotencyKey: string | undefined,
    @Body() input: GenerateSceneTranslationDto,
  ) {
    return this.localization.createGeneration(
      context,
      projectId,
      trackId,
      idempotencyKey ?? '',
      input,
    );
  }

  @Get(':trackId/generations/:generationId')
  @Header('Cache-Control', 'private, no-store')
  @ApiOperation({ summary: 'Get authoritative translation generation status.' })
  getGeneration(
    @CurrentAuth() context: AccessContext,
    @Param('projectId') projectId: string,
    @Param('trackId') trackId: string,
    @Param('generationId') generationId: string,
  ) {
    return this.localization.getGeneration(context, projectId, trackId, generationId);
  }
}
