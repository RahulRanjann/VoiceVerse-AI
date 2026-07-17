import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import { IsInt, IsOptional, IsString, Max, MaxLength, Min } from 'class-validator';

export enum SpeechAnalysisResultAvailability {
  PENDING = 'PENDING',
  AVAILABLE = 'AVAILABLE',
  UNAVAILABLE = 'UNAVAILABLE',
}

export class ListSpeechAnalysisResultsQueryDto {
  @ApiPropertyOptional({ default: 25, maximum: 100, minimum: 1 })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(100)
  limit = 25;

  @ApiPropertyOptional({ description: 'Opaque, analysis-bound keyset pagination cursor.' })
  @IsOptional()
  @IsString()
  @MaxLength(1024)
  cursor?: string;
}

export class CharacterSummaryDto {
  @ApiProperty({ format: 'uuid' })
  id!: string;

  @ApiProperty()
  displayName!: string;

  @ApiProperty({ minimum: 0 })
  firstAppearanceMs!: number;

  @ApiProperty({ minimum: 0 })
  segmentCount!: number;

  @ApiProperty({ minimum: 0 })
  speakingDurationMs!: number;

  @ApiProperty({ maximum: 10_000, minimum: 0 })
  confidenceBasisPoints!: number;
}

export class DialogueCharacterDto {
  @ApiProperty({ format: 'uuid' })
  id!: string;

  @ApiProperty()
  displayName!: string;

  @ApiProperty({ maximum: 10_000, minimum: 0 })
  assignmentConfidenceBasisPoints!: number;
}

export class DialogueSegmentSummaryDto {
  @ApiProperty({ format: 'uuid' })
  id!: string;

  @ApiProperty({ minimum: 0 })
  sequenceNumber!: number;

  @ApiProperty({ minimum: 0 })
  startMs!: number;

  @ApiProperty({ minimum: 0 })
  endMs!: number;

  @ApiProperty()
  sourceText!: string;

  @ApiProperty({ example: 'en' })
  sourceLanguageTag!: string;

  @ApiProperty({ maximum: 10_000, minimum: 0 })
  transcriptionConfidenceBasisPoints!: number;

  @ApiProperty({ nullable: true, type: DialogueCharacterDto })
  character!: DialogueCharacterDto | null;
}

export class CharacterResultPageDto {
  @ApiProperty({ enum: SpeechAnalysisResultAvailability })
  availability!: SpeechAnalysisResultAvailability;

  @ApiProperty({ format: 'uuid', nullable: true })
  analysisId!: string | null;

  @ApiProperty({ minimum: 1 })
  jobRevision!: number;

  @ApiProperty({ isArray: true, type: CharacterSummaryDto })
  data!: CharacterSummaryDto[];

  @ApiProperty({ minimum: 0 })
  totalCount!: number;

  @ApiProperty({ nullable: true })
  nextCursor!: string | null;
}

export class DialogueSegmentResultPageDto {
  @ApiProperty({ enum: SpeechAnalysisResultAvailability })
  availability!: SpeechAnalysisResultAvailability;

  @ApiProperty({ format: 'uuid', nullable: true })
  analysisId!: string | null;

  @ApiProperty({ minimum: 1 })
  jobRevision!: number;

  @ApiProperty({ isArray: true, type: DialogueSegmentSummaryDto })
  data!: DialogueSegmentSummaryDto[];

  @ApiProperty({ minimum: 0 })
  totalCount!: number;

  @ApiProperty({ nullable: true })
  nextCursor!: string | null;
}
