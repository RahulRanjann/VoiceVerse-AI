import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import {
  ArrayMaxSize,
  ArrayMinSize,
  ArrayUnique,
  IsArray,
  IsInt,
  IsMimeType,
  IsOptional,
  IsString,
  Matches,
  Max,
  MaxLength,
  Min,
  MinLength,
  ValidateNested,
} from 'class-validator';

export class CreateMultipartUploadDto {
  @ApiProperty({ example: 'monsoon-letters-master.mp4' })
  @IsString()
  @MinLength(1)
  @MaxLength(255)
  filename!: string;

  @ApiProperty({ example: 'video/mp4' })
  @IsMimeType()
  mediaType!: string;

  @ApiProperty({ example: 7_301_444_608, maximum: 5_497_558_138_880 })
  @IsInt()
  @Min(1)
  @Max(5_497_558_138_880)
  byteSize!: number;

  @ApiPropertyOptional({ description: 'Lowercase SHA-256 digest of the whole file.' })
  @IsOptional()
  @IsString()
  @Matches(/^[0-9a-f]{64}$/)
  sha256?: string;
}

export class SignPartsDto {
  @ApiProperty({ isArray: true, type: Number })
  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(100)
  @ArrayUnique()
  @IsInt({ each: true })
  @Min(1, { each: true })
  @Max(10_000, { each: true })
  partNumbers!: number[];
}

export class CompletedPartDto {
  @ApiProperty()
  @IsInt()
  @Min(1)
  @Max(10_000)
  partNumber!: number;

  @ApiProperty()
  @IsString()
  @MinLength(1)
  @MaxLength(512)
  @Matches(/^[\x20-\x7e]+$/)
  etag!: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsInt()
  @Min(1)
  byteSize?: number;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @Matches(/^[0-9a-f]{64}$/)
  checksumSha256?: string;
}

export class CompleteMultipartUploadDto {
  @ApiProperty({ isArray: true, type: CompletedPartDto })
  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(10_000)
  @ValidateNested({ each: true })
  @Type(() => CompletedPartDto)
  parts!: CompletedPartDto[];
}
