import { createParamDecorator, type ExecutionContext } from '@nestjs/common';
import type { FastifyRequest } from 'fastify';

import type { AccessContext, AuthenticatedRequest } from '../domain/access-context';

export const CurrentAuth = createParamDecorator(
  (_data: unknown, context: ExecutionContext): AccessContext => {
    const request = context.switchToHttp().getRequest<FastifyRequest & AuthenticatedRequest>();
    return request.auth;
  },
);
