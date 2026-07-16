import { Module } from '@nestjs/common';

import { AccessTokenService } from './application/access-token.service';
import { AuthService } from './application/auth.service';
import { SecureValuesService } from './application/secure-values.service';
import { GOOGLE_IDENTITY_PROVIDER } from './domain/identity-provider.port';
import { GoogleIdentityProvider } from './infrastructure/google-identity.provider';
import { AccessTokenGuard } from './presentation/access-token.guard';
import { AuthController } from './presentation/auth.controller';
import { CookieMutationGuard } from './presentation/cookie-mutation.guard';

@Module({
  controllers: [AuthController],
  exports: [AccessTokenGuard, AccessTokenService],
  providers: [
    AccessTokenGuard,
    AccessTokenService,
    AuthService,
    CookieMutationGuard,
    GoogleIdentityProvider,
    SecureValuesService,
    {
      provide: GOOGLE_IDENTITY_PROVIDER,
      useExisting: GoogleIdentityProvider,
    },
  ],
})
export class IdentityModule {}
