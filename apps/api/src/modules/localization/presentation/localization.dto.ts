import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { TranslationEditorState } from '@voiceverse/database';
import { Type } from 'class-transformer';
import {
  IsBoolean,
  IsEnum,
  IsInt,
  IsNotEmpty,
  IsOptional,
  IsString,
  IsUUID,
  Max,
  MaxLength,
  Min,
} from 'class-validator';

export class CreateLocalizationTrackDto {
  @ApiProperty({ format: 'uuid' })
  @IsUUID()
  speechAnalysisJobId!: string;

  @ApiProperty({ format: 'uuid' })
  @IsUUID()
  targetLanguageId!: string;
}

export class ListLocalizationScenesQueryDto {
  @ApiPropertyOptional({ default: 8, maximum: 25, minimum: 1 })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(25)
  limit = 8;

  @ApiPropertyOptional({ description: 'Opaque track-bound keyset cursor.' })
  @IsOptional()
  @IsString()
  @MaxLength(1024)
  cursor?: string;
}

export class ListLocalizationHistoryQueryDto {
  @ApiPropertyOptional({ default: 25, maximum: 100, minimum: 1 })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(100)
  limit = 25;

  @ApiPropertyOptional({ description: 'Opaque resource-bound keyset cursor.' })
  @IsOptional()
  @IsString()
  @MaxLength(1024)
  cursor?: string;
}

export class ExpectedSelectionRevisionDto {
  @ApiProperty({
    description: 'Positive optimistic concurrency revision of the active pointer.',
  })
  @Type(() => Number)
  @IsInt()
  @Min(1)
  expectedRevision!: number;
}

export class UpdateSceneRevisionDto extends ExpectedSelectionRevisionDto {
  @ApiPropertyOptional({ maxLength: 200, nullable: true })
  @IsOptional()
  @IsString()
  @MaxLength(200)
  title?: string | null;

  @ApiPropertyOptional({ maxLength: 4_000, nullable: true })
  @IsOptional()
  @IsString()
  @MaxLength(4_000)
  narrative?: string | null;

  @ApiPropertyOptional({ maxLength: 8_000, nullable: true })
  @IsOptional()
  @IsString()
  @MaxLength(8_000)
  culturalNotes?: string | null;
}

export class UpdateSourceDialogueRevisionDto extends ExpectedSelectionRevisionDto {
  @ApiProperty({ maxLength: 10_000 })
  @IsString()
  @IsNotEmpty()
  @MaxLength(10_000)
  sourceText!: string;
}

export class UpdateTranslationRevisionDto {
  @ApiProperty({
    description:
      'Optimistic concurrency revision of the active pointer. Use 0 when creating the first manual translation.',
  })
  @Type(() => Number)
  @IsInt()
  @Min(0)
  expectedRevision!: number;

  @ApiProperty({ maxLength: 10_000 })
  @IsString()
  @IsNotEmpty()
  @MaxLength(10_000)
  targetText!: string;
}

export class UpdateTranslationStateDto extends ExpectedSelectionRevisionDto {
  @ApiProperty({ enum: TranslationEditorState, enumName: 'TranslationEditorState' })
  @IsEnum(TranslationEditorState)
  state!: TranslationEditorState;
}

export class SelectLocalizationRevisionDto extends ExpectedSelectionRevisionDto {
  @ApiProperty({ format: 'uuid' })
  @IsUUID()
  revisionId!: string;
}

export class CreateGlossaryEntryDto {
  @ApiProperty({ maxLength: 200 })
  @IsString()
  @IsNotEmpty()
  @MaxLength(200)
  sourceTerm!: string;

  @ApiPropertyOptional({ maxLength: 200, nullable: true })
  @IsOptional()
  @IsString()
  @MaxLength(200)
  targetTerm?: string | null;

  @ApiPropertyOptional({ maxLength: 1_000, nullable: true })
  @IsOptional()
  @IsString()
  @MaxLength(1_000)
  notes?: string | null;

  @ApiProperty({ default: false })
  @IsBoolean()
  caseSensitive!: boolean;

  @ApiProperty({ default: false })
  @IsBoolean()
  doNotTranslate!: boolean;
}

export class UpdateGlossaryRevisionDto extends CreateGlossaryEntryDto {
  @ApiProperty({ description: 'Optimistic concurrency revision of the active pointer.' })
  @Type(() => Number)
  @IsInt()
  @Min(1)
  expectedRevision!: number;
}

export class GenerateSceneTranslationDto {
  @ApiProperty({ format: 'uuid' })
  @IsUUID()
  sceneId!: string;
}
