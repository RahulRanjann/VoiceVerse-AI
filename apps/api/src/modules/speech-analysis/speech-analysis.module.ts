import { Module } from '@nestjs/common';

import { IdentityModule } from '../identity/identity.module';
import { SpeechAnalysisQueryService } from './application/speech-analysis-query.service';
import { SpeechAnalysisQueryController } from './presentation/speech-analysis-query.controller';

@Module({
  controllers: [SpeechAnalysisQueryController],
  imports: [IdentityModule],
  providers: [SpeechAnalysisQueryService],
})
export class SpeechAnalysisModule {}
