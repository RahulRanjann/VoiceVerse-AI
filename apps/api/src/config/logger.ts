import { trace } from '@opentelemetry/api';
import type { ConfigService } from '@nestjs/config';
import { randomUUID } from 'node:crypto';

import type { Environment } from './environment';

const requestIdPattern = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;

export function createLoggerOptions(config: ConfigService<Environment, true>) {
  return {
    pinoHttp: {
      level: config.get('LOG_LEVEL', { infer: true }),
      redact: {
        censor: '[REDACTED]',
        paths: [
          'req.headers.authorization',
          'req.headers.cookie',
          'res.headers.set-cookie',
          '*.accessToken',
          '*.refreshToken',
          '*.password',
          '*.secret',
          '*.signedUrl',
          '*.url',
        ],
      },
      genReqId(request: { headers: Record<string, string | string[] | undefined> }) {
        const suppliedId = request.headers['x-request-id'];
        return typeof suppliedId === 'string' && requestIdPattern.test(suppliedId)
          ? suppliedId
          : randomUUID();
      },
      customProps() {
        const spanContext = trace.getActiveSpan()?.spanContext();
        return spanContext ? { traceId: spanContext.traceId, spanId: spanContext.spanId } : {};
      },
    },
  };
}
