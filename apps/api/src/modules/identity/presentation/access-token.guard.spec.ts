import {
  BadRequestException,
  type ExecutionContext,
  ForbiddenException,
  UnauthorizedException,
} from '@nestjs/common';
import { describe, expect, it, vi } from 'vitest';

import type { IdentityPrincipalService } from '../application/identity-principal.service';
import { AccessTokenGuard } from './access-token.guard';

const organizationId = '01900000-0000-7000-8000-000000000010';
const verifiedIdentity = {
  avatarUrl: null,
  displayName: 'Creator',
  email: 'creator@example.com',
  provider: 'google',
  sessionId: '01900000-0000-7000-8000-000000000011',
  subject: '01900000-0000-7000-8000-000000000012',
};
const accessContext = {
  organizationId,
  role: 'OWNER',
  sessionId: verifiedIdentity.sessionId,
  userId: '01900000-0000-7000-8000-000000000013',
};

function harness(headers: Record<string, string | string[] | undefined>) {
  const request = { headers };
  const context = {
    switchToHttp: () => ({ getRequest: () => request }),
  } as unknown as ExecutionContext;
  const tokens = { verify: vi.fn().mockResolvedValue(verifiedIdentity) };
  const principals = { resolve: vi.fn().mockResolvedValue(accessContext) };
  const guard = new AccessTokenGuard(tokens, principals as unknown as IdentityPrincipalService);
  return { context, guard, principals, request, tokens };
}

describe('AccessTokenGuard', () => {
  it('verifies the token and resolves tenant context server-side', async () => {
    const test = harness({
      authorization: 'Bearer signed-token',
      'x-voiceverse-organization-id': organizationId,
    });

    await expect(test.guard.canActivate(test.context)).resolves.toBe(true);
    expect(test.tokens.verify).toHaveBeenCalledWith('signed-token');
    expect(test.principals.resolve).toHaveBeenCalledWith(verifiedIdentity, organizationId);
    expect(test.request).toHaveProperty('auth', accessContext);
  });

  it('rejects missing, malformed, and failed token verification', async () => {
    await expect(harness({}).guard.canActivate(harness({}).context)).rejects.toBeInstanceOf(
      UnauthorizedException,
    );
    const failed = harness({ authorization: 'Bearer invalid-token' });
    failed.tokens.verify.mockRejectedValue(new Error('invalid'));
    await expect(failed.guard.canActivate(failed.context)).rejects.toBeInstanceOf(
      UnauthorizedException,
    );
  });

  it('rejects ambiguous or invalid tenant headers before database authorization', async () => {
    const ambiguous = harness({
      authorization: 'Bearer signed-token',
      'x-voiceverse-organization-id': [organizationId, organizationId],
    });
    await expect(ambiguous.guard.canActivate(ambiguous.context)).rejects.toBeInstanceOf(
      BadRequestException,
    );

    const malformed = harness({
      authorization: 'Bearer signed-token',
      'x-voiceverse-organization-id': 'not-a-uuid',
    });
    await expect(malformed.guard.canActivate(malformed.context)).rejects.toBeInstanceOf(
      BadRequestException,
    );
  });

  it('preserves authorization failures from principal resolution', async () => {
    const test = harness({ authorization: 'Bearer signed-token' });
    test.principals.resolve.mockRejectedValue(new ForbiddenException('membership unavailable'));

    await expect(test.guard.canActivate(test.context)).rejects.toBeInstanceOf(ForbiddenException);
  });
});
