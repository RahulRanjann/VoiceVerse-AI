import { Module } from '@nestjs/common';

import { IdentityPrincipalService } from './application/identity-principal.service';
import { EXTERNAL_ACCESS_TOKEN_VERIFIER } from './domain/external-access-token-verifier.port';
import { SupabaseAccessTokenVerifier } from './infrastructure/supabase-access-token.verifier';
import { AccessTokenGuard } from './presentation/access-token.guard';
import { AuthController } from './presentation/auth.controller';

@Module({
  controllers: [AuthController],
  exports: [AccessTokenGuard, EXTERNAL_ACCESS_TOKEN_VERIFIER, IdentityPrincipalService],
  providers: [
    AccessTokenGuard,
    IdentityPrincipalService,
    SupabaseAccessTokenVerifier,
    {
      provide: EXTERNAL_ACCESS_TOKEN_VERIFIER,
      useExisting: SupabaseAccessTokenVerifier,
    },
  ],
})
export class IdentityModule {}
