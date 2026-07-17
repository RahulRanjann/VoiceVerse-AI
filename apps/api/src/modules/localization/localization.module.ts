import { Module } from '@nestjs/common';

import { IdentityModule } from '../identity/identity.module';
import { LocalizationService } from './application/localization.service';
import { LocalizationController } from './presentation/localization.controller';

@Module({
  controllers: [LocalizationController],
  imports: [IdentityModule],
  providers: [LocalizationService],
})
export class LocalizationModule {}
