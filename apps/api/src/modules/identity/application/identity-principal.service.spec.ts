import { ForbiddenException } from '@nestjs/common';
import {
  IdentityProvider,
  OrganizationRole,
  OrganizationStatus,
  UserStatus,
} from '@voiceverse/database';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { DatabaseService } from '../../../infrastructure/database/database.service';
import { IdentityPrincipalService } from './identity-principal.service';

const userId = '01900000-0000-7000-8000-000000000021';
const organizationId = '01900000-0000-7000-8000-000000000022';
const sessionId = '01900000-0000-7000-8000-000000000023';
const external = {
  avatarUrl: 'https://images.example.com/avatar.png',
  displayName: 'Voice Creator',
  email: 'creator@example.com',
  provider: 'google',
  sessionId,
  subject: '01900000-0000-7000-8000-000000000024',
};
const user = {
  avatarUrl: external.avatarUrl,
  displayName: external.displayName,
  email: external.email,
  id: userId,
  status: UserStatus.ACTIVE,
};
const organization = {
  displayName: 'Creator Studio',
  id: organizationId,
  slug: 'creator-studio',
  status: OrganizationStatus.ACTIVE,
};
const membership = {
  createdAt: new Date(),
  id: '01900000-0000-7000-8000-000000000025',
  organization,
  organizationId,
  role: OrganizationRole.OWNER,
  updatedAt: new Date(),
  userId,
};

function harness() {
  const transaction = {
    $queryRaw: vi.fn().mockResolvedValue([{ pg_advisory_xact_lock: null }]),
    auditLog: { create: vi.fn() },
    externalIdentity: {
      create: vi.fn(),
      findUnique: vi.fn(),
      update: vi.fn(),
    },
    organization: { create: vi.fn() },
    organizationMembership: {
      create: vi.fn(),
      findFirst: vi.fn(),
      findUnique: vi.fn(),
    },
    user: { create: vi.fn(), findUnique: vi.fn() },
  };
  const client = {
    $transaction: vi.fn((operation: (value: typeof transaction) => unknown) =>
      operation(transaction),
    ),
    organizationMembership: { findUnique: vi.fn() },
  };
  const service = new IdentityPrincipalService({ client } as unknown as DatabaseService);
  return { client, service, transaction };
}

describe('IdentityPrincipalService', () => {
  beforeEach(() => vi.useRealTimers());

  it('resolves an existing external identity to an active membership', async () => {
    const test = harness();
    test.transaction.externalIdentity.findUnique.mockResolvedValue({
      ...external,
      id: '01900000-0000-7000-8000-000000000026',
      lastLoginAt: new Date(),
      user,
      userId,
    });
    test.transaction.organizationMembership.findFirst.mockResolvedValue(membership);

    await expect(test.service.resolve(external)).resolves.toEqual({
      organizationId,
      role: OrganizationRole.OWNER,
      sessionId,
      userId,
    });
    expect(test.transaction.$queryRaw).not.toHaveBeenCalled();
    expect(test.transaction.externalIdentity.create).not.toHaveBeenCalled();
  });

  it('provisions a new user and personal organization transactionally', async () => {
    const test = harness();
    test.transaction.externalIdentity.findUnique.mockResolvedValue(null);
    test.transaction.user.findUnique.mockResolvedValue(null);
    test.transaction.user.create.mockResolvedValue(user);
    test.transaction.externalIdentity.create.mockResolvedValue({
      id: '01900000-0000-7000-8000-000000000027',
      lastLoginAt: new Date(),
      user,
      userId,
    });
    test.transaction.organizationMembership.findFirst.mockResolvedValue(null);
    test.transaction.organization.create.mockResolvedValue(organization);
    test.transaction.organizationMembership.create.mockResolvedValue({
      ...membership,
      organization: undefined,
    });

    await expect(test.service.resolve(external)).resolves.toMatchObject({
      role: OrganizationRole.OWNER,
      sessionId,
      userId,
    });
    expect(test.transaction.externalIdentity.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ provider: IdentityProvider.SUPABASE }),
      }),
    );
    expect(test.transaction.externalIdentity.findUnique).toHaveBeenCalledTimes(2);
    expect(test.transaction.$queryRaw).toHaveBeenCalledOnce();
    const lockQuery: unknown = test.transaction.$queryRaw.mock.calls[0]?.[0];
    expect(Array.isArray(lockQuery) ? lockQuery.join('') : '').toContain('::text AS lock_result');
    expect(test.transaction.auditLog.create).toHaveBeenCalledOnce();
  });

  it('rechecks identity state after acquiring the first-login lock', async () => {
    const test = harness();
    test.transaction.externalIdentity.findUnique.mockResolvedValueOnce(null).mockResolvedValueOnce({
      id: '01900000-0000-7000-8000-000000000029',
      lastLoginAt: new Date(),
      user,
      userId,
    });
    test.transaction.organizationMembership.findFirst.mockResolvedValue(membership);

    await expect(test.service.resolve(external)).resolves.toMatchObject({
      organizationId,
      sessionId,
      userId,
    });
    expect(test.transaction.$queryRaw).toHaveBeenCalledOnce();
    expect(test.transaction.externalIdentity.create).not.toHaveBeenCalled();
    expect(test.transaction.auditLog.create).not.toHaveBeenCalled();
  });

  it('does not auto-link an existing email without a trusted legacy Google identity', async () => {
    const test = harness();
    test.transaction.externalIdentity.findUnique.mockResolvedValue(null);
    test.transaction.user.findUnique.mockResolvedValue({ ...user, identities: [] });

    await expect(test.service.resolve(external)).rejects.toBeInstanceOf(ForbiddenException);
    expect(test.transaction.externalIdentity.create).not.toHaveBeenCalled();
  });

  it('fails closed when an explicitly requested organization is unavailable', async () => {
    const test = harness();
    test.transaction.externalIdentity.findUnique.mockResolvedValue({
      id: '01900000-0000-7000-8000-000000000028',
      lastLoginAt: new Date(),
      user,
      userId,
    });
    test.transaction.organizationMembership.findUnique.mockResolvedValue(null);

    await expect(test.service.resolve(external, organizationId)).rejects.toBeInstanceOf(
      ForbiddenException,
    );
  });

  it('returns the canonical principal only while user and organization are active', async () => {
    const test = harness();
    test.client.organizationMembership.findUnique.mockResolvedValue({
      ...membership,
      user,
    });

    await expect(
      test.service.describe({ organizationId, role: OrganizationRole.OWNER, sessionId, userId }),
    ).resolves.toEqual({
      organization: {
        displayName: organization.displayName,
        id: organizationId,
        role: OrganizationRole.OWNER,
        slug: organization.slug,
      },
      user: {
        avatarUrl: user.avatarUrl,
        displayName: user.displayName,
        email: user.email,
        id: userId,
      },
    });

    test.client.organizationMembership.findUnique.mockResolvedValue({
      ...membership,
      organization: { ...organization, status: OrganizationStatus.SUSPENDED },
      user,
    });
    await expect(
      test.service.describe({ organizationId, role: OrganizationRole.OWNER, sessionId, userId }),
    ).rejects.toBeInstanceOf(ForbiddenException);
  });
});
