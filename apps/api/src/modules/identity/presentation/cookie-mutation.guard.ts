import { CanActivate, ExecutionContext, Injectable, UnauthorizedException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { FastifyRequest } from 'fastify';

import type { Environment } from '../../../config/environment';

@Injectable()
export class CookieMutationGuard implements CanActivate {
  private readonly expectedOrigin: string;
  private readonly requireOrigin: boolean;

  constructor(config: ConfigService<Environment, true>) {
    this.expectedOrigin = new URL(config.get('WEB_ORIGIN', { infer: true })).origin;
    this.requireOrigin = config.get('NODE_ENV', { infer: true }) === 'production';
  }

  canActivate(context: ExecutionContext): boolean {
    const request = context.switchToHttp().getRequest<FastifyRequest>();
    const origin = request.headers.origin;
    if ((!origin && this.requireOrigin) || (origin && origin !== this.expectedOrigin)) {
      throw new UnauthorizedException('The request origin is not allowed.');
    }
    return true;
  }
}
