import {
  BadRequestException,
  CanActivate,
  ExecutionContext,
  Inject,
  Injectable,
  UnauthorizedException,
} from '@nestjs/common';
import type { FastifyRequest } from 'fastify';
import { z } from 'zod';

import { IdentityPrincipalService } from '../application/identity-principal.service';
import type { AuthenticatedRequest } from '../domain/access-context';
import {
  EXTERNAL_ACCESS_TOKEN_VERIFIER,
  type ExternalAccessTokenVerifierPort,
} from '../domain/external-access-token-verifier.port';

const organizationIdSchema = z.string().uuid();

@Injectable()
export class AccessTokenGuard implements CanActivate {
  constructor(
    @Inject(EXTERNAL_ACCESS_TOKEN_VERIFIER)
    private readonly tokens: ExternalAccessTokenVerifierPort,
    private readonly principals: IdentityPrincipalService,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const request = context
      .switchToHttp()
      .getRequest<FastifyRequest & Partial<AuthenticatedRequest>>();
    const authorization = request.headers.authorization;
    const match = authorization?.match(/^Bearer ([A-Za-z0-9._~-]+)$/);
    if (!match?.[1] || match[1].length > 16_384) {
      throw new UnauthorizedException('A valid bearer access token is required.');
    }

    let external;
    try {
      external = await this.tokens.verify(match[1]);
    } catch {
      throw new UnauthorizedException('A valid bearer access token is required.');
    }

    const organizationHeader = request.headers['x-voiceverse-organization-id'];
    if (Array.isArray(organizationHeader)) {
      throw new BadRequestException('Only one organization header may be supplied.');
    }
    if (organizationHeader && !organizationIdSchema.safeParse(organizationHeader).success) {
      throw new BadRequestException('The organization header must be a UUID.');
    }

    request.auth = await this.principals.resolve(external, organizationHeader);
    return true;
  }
}
