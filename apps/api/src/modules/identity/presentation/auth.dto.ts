import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { IsOptional, IsString, Matches, MaxLength, MinLength } from 'class-validator';

export class GoogleStartQueryDto {
  @ApiPropertyOptional({ default: '/', description: 'Internal web path after sign-in.' })
  @IsOptional()
  @IsString()
  @MaxLength(512)
  @Matches(/^\/(?!\/)/)
  redirectPath?: string;
}

export class GoogleCallbackQueryDto {
  @ApiProperty()
  @IsString()
  @MinLength(1)
  @MaxLength(4096)
  code!: string;

  @ApiProperty()
  @IsString()
  @MinLength(20)
  @MaxLength(512)
  state!: string;
}
