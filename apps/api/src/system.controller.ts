import { Controller, Get } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { ApiOkResponse, ApiProperty, ApiTags } from '@nestjs/swagger';

import type { Environment } from './config/environment';

class SystemResponseDto {
  @ApiProperty({ example: 'voiceverse-api' })
  service!: string;

  @ApiProperty({ example: '0.0.0-development' })
  version!: string;
}

@ApiTags('system')
@Controller({ path: 'system', version: '1' })
export class SystemController {
  constructor(private readonly config: ConfigService<Environment, true>) {}

  @Get()
  @ApiOkResponse({ type: SystemResponseDto })
  getSystem(): SystemResponseDto {
    return {
      service: 'voiceverse-api',
      version: this.config.get('APP_VERSION', { infer: true }),
    };
  }
}
