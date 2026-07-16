import { CanActivate, ExecutionContext, Injectable, UnauthorizedException } from '@nestjs/common';
import type { FastifyRequest } from 'fastify';

import { AccessTokenService } from '../application/access-token.service';
import type { AuthenticatedRequest } from '../domain/access-context';

@Injectable()
export class AccessTokenGuard implements CanActivate {
  constructor(private readonly tokens: AccessTokenService) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const request = context
      .switchToHttp()
      .getRequest<FastifyRequest & Partial<AuthenticatedRequest>>();
    const authorization = request.headers.authorization;
    const match = authorization?.match(/^Bearer ([A-Za-z0-9._~-]+)$/);
    if (!match?.[1]) {
      throw new UnauthorizedException('A valid bearer access token is required.');
    }

    try {
      request.auth = await this.tokens.verify(match[1]);
      return true;
    } catch {
      throw new UnauthorizedException('A valid bearer access token is required.');
    }
  }
}
