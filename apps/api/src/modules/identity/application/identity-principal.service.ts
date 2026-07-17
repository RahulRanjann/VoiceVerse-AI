import { ForbiddenException, Injectable, Logger, UnauthorizedException } from '@nestjs/common';
import {
  IdentityProvider,
  OrganizationRole,
  OrganizationStatus,
  type Prisma,
  UserStatus,
} from '@voiceverse/database';

import { DatabaseService } from '../../../infrastructure/database/database.service';
import { uuidv7 } from '../../../shared/uuid';
import type { AccessContext } from '../domain/access-context';
import type { VerifiedExternalAccessToken } from '../domain/external-access-token-verifier.port';

export interface AuthPrincipal {
  user: {
    id: string;
    email: string;
    displayName: string | null;
    avatarUrl: string | null;
  };
  organization: {
    id: string;
    displayName: string;
    slug: string;
    role: OrganizationRole;
  };
}

@Injectable()
export class IdentityPrincipalService {
  private readonly logger = new Logger(IdentityPrincipalService.name);

  constructor(private readonly database: DatabaseService) {}

  async resolve(
    external: VerifiedExternalAccessToken,
    requestedOrganizationId?: string,
  ): Promise<AccessContext> {
    return this.database.client.$transaction(async (transaction) => {
      let identity = await transaction.externalIdentity.findUnique({
        include: { user: true },
        where: {
          provider_providerSubject: {
            provider: IdentityProvider.SUPABASE,
            providerSubject: external.subject,
          },
        },
      });
      let linkedNow = false;
      if (!identity) {
        // Serialize only first-login provisioning. Known users remain free to
        // make concurrent API calls across replicas without a per-user lock.
        const lockKey = `supabase:${external.subject}`;
        // PostgreSQL returns `void` from pg_advisory_xact_lock. Cast the
        // intentionally ignored result so Prisma's driver never has to
        // deserialize an unsupported native type.
        await transaction.$queryRaw`SELECT pg_advisory_xact_lock(hashtextextended(${lockKey}, 0))::text AS lock_result`;
        identity = await transaction.externalIdentity.findUnique({
          include: { user: true },
          where: {
            provider_providerSubject: {
              provider: IdentityProvider.SUPABASE,
              providerSubject: external.subject,
            },
          },
        });
      }
      if (!identity) {
        const user = await this.resolveLinkableUser(transaction, external);
        identity = await transaction.externalIdentity.create({
          data: {
            emailAtLink: external.email,
            id: uuidv7(),
            provider: IdentityProvider.SUPABASE,
            providerSubject: external.subject,
            userId: user.id,
          },
          include: { user: true },
        });
        linkedNow = true;
      }

      if (identity.user.status !== UserStatus.ACTIVE) {
        throw new UnauthorizedException('The VoiceVerse account is inactive.');
      }

      let membership = requestedOrganizationId
        ? await transaction.organizationMembership.findUnique({
            include: { organization: true },
            where: {
              organizationId_userId: {
                organizationId: requestedOrganizationId,
                userId: identity.userId,
              },
            },
          })
        : await transaction.organizationMembership.findFirst({
            include: { organization: true },
            orderBy: { createdAt: 'asc' },
            where: {
              organization: { status: OrganizationStatus.ACTIVE },
              userId: identity.userId,
            },
          });

      if (!membership && linkedNow && !requestedOrganizationId) {
        membership = await this.createPersonalOrganization(transaction, identity.user);
      }
      if (!membership || membership.organization.status !== OrganizationStatus.ACTIVE) {
        throw new ForbiddenException('The requested organization membership is unavailable.');
      }

      if (linkedNow) {
        await transaction.auditLog.create({
          data: {
            action: 'auth.supabase.identity_linked',
            actorUserId: identity.userId,
            id: uuidv7(),
            organizationId: membership.organizationId,
            resourceId: identity.userId,
            resourceType: 'user',
          },
        });
        this.logger.log(
          { organizationId: membership.organizationId, userId: identity.userId },
          'Supabase identity linked to VoiceVerse principal',
        );
      } else if (identity.lastLoginAt < new Date(Date.now() - 15 * 60_000)) {
        await transaction.externalIdentity.update({
          data: { lastLoginAt: new Date() },
          where: { id: identity.id },
        });
      }

      return {
        organizationId: membership.organizationId,
        role: membership.role,
        sessionId: external.sessionId,
        userId: identity.userId,
      };
    });
  }

  async describe(context: AccessContext): Promise<AuthPrincipal> {
    const membership = await this.database.client.organizationMembership.findUnique({
      include: { organization: true, user: true },
      where: {
        organizationId_userId: {
          organizationId: context.organizationId,
          userId: context.userId,
        },
      },
    });
    if (
      !membership ||
      membership.user.status !== UserStatus.ACTIVE ||
      membership.organization.status !== OrganizationStatus.ACTIVE
    ) {
      throw new ForbiddenException('The active VoiceVerse principal is unavailable.');
    }

    return {
      organization: {
        displayName: membership.organization.displayName,
        id: membership.organization.id,
        role: membership.role,
        slug: membership.organization.slug,
      },
      user: {
        avatarUrl: membership.user.avatarUrl,
        displayName: membership.user.displayName,
        email: membership.user.email,
        id: membership.user.id,
      },
    };
  }

  private async resolveLinkableUser(
    transaction: Prisma.TransactionClient,
    external: VerifiedExternalAccessToken,
  ) {
    const existing = await transaction.user.findUnique({
      include: { identities: true },
      where: { email: external.email },
    });
    if (!existing) {
      return transaction.user.create({
        data: {
          avatarUrl: external.avatarUrl,
          displayName: external.displayName,
          email: external.email,
          id: uuidv7(),
        },
      });
    }

    const trustedLegacyGoogleIdentity = existing.identities.some(
      (identity) =>
        identity.provider === IdentityProvider.GOOGLE &&
        identity.emailAtLink.toLowerCase() === external.email,
    );
    if (!trustedLegacyGoogleIdentity) {
      throw new ForbiddenException('This email requires an explicit account-linking review.');
    }
    return existing;
  }

  private async createPersonalOrganization(
    transaction: Prisma.TransactionClient,
    user: { id: string; displayName: string | null; email: string },
  ) {
    const organizationId = uuidv7();
    const displayName = `${user.displayName ?? user.email.split('@')[0] ?? 'VoiceVerse'} Studio`;
    const organization = await transaction.organization.create({
      data: {
        displayName: displayName.slice(0, 160),
        id: organizationId,
        slug: this.organizationSlug(displayName, organizationId),
      },
    });
    const membership = await transaction.organizationMembership.create({
      data: {
        id: uuidv7(),
        organizationId,
        role: OrganizationRole.OWNER,
        userId: user.id,
      },
    });
    return { ...membership, organization };
  }

  private organizationSlug(displayName: string, organizationId: string): string {
    const base =
      displayName
        .normalize('NFKD')
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, '-')
        .replace(/^-|-$/g, '')
        .slice(0, 48) || 'studio';
    return `${base}-${organizationId.replaceAll('-', '').slice(-10)}`.slice(0, 63);
  }
}
