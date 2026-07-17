import { Controller, Get, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';

import { IdentityPrincipalService } from '../application/identity-principal.service';
import type { AccessContext } from '../domain/access-context';
import { AccessTokenGuard } from './access-token.guard';
import { CurrentAuth } from './current-auth.decorator';

@ApiTags('Authentication')
@Controller({ path: 'auth', version: '1' })
export class AuthController {
  constructor(private readonly principals: IdentityPrincipalService) {}

  @Get('me')
  @UseGuards(AccessTokenGuard)
  @ApiBearerAuth()
  @ApiOperation({ summary: 'Return the authenticated user and active organization.' })
  me(@CurrentAuth() context: AccessContext) {
    return this.principals.describe(context);
  }
}
