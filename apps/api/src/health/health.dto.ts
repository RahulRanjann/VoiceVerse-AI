import { ApiProperty } from '@nestjs/swagger';

export class HealthResponseDto {
  @ApiProperty({ example: 'voiceverse-api' })
  service!: string;

  @ApiProperty({ enum: ['ok', 'error'], example: 'ok' })
  status!: 'ok' | 'error';

  @ApiProperty({ example: '2026-07-16T12:00:00.000Z' })
  timestamp!: string;
}

export class ReadinessCheckDto {
  @ApiProperty({ enum: ['up', 'down'], example: 'up' })
  status!: 'up' | 'down';

  @ApiProperty({ example: 12 })
  latencyMs!: number;
}

export class ReadinessResponseDto extends HealthResponseDto {
  @ApiProperty({
    example: {
      database: { status: 'up', latencyMs: 8 },
      redis: { status: 'up', latencyMs: 3 },
    },
  })
  checks!: Record<string, ReadinessCheckDto>;
}
