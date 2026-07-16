import { Inject, Injectable, Logger, UnauthorizedException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import {
  IdentityProvider,
  OrganizationRole,
  OrganizationStatus,
  UserStatus,
} from '@voiceverse/database';
import type { Environment } from '../../../config/environment';
import { DatabaseService } from '../../../infrastructure/database/database.service';
import { uuidv7 } from '../../../shared/uuid';
import type { AccessContext } from '../domain/access-context';
import {
  GOOGLE_IDENTITY_PROVIDER,
  type IdentityProviderPort,
  type VerifiedExternalIdentity,
} from '../domain/identity-provider.port';
import { AccessTokenService } from './access-token.service';
import { SecureValuesService } from './secure-values.service';

interface ClientFingerprint {
  ipAddress?: string;
  userAgent?: string;
}

interface Principal {
  userId: string;
  email: string;
  displayName: string | null;
  avatarUrl: string | null;
  organizationId: string;
  organizationName: string;
  organizationSlug: string;
  role: OrganizationRole;
}

export interface BrowserSession {
  accessToken: string;
  expiresInSeconds: number;
  refreshToken: string;
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

export interface CompletedAuthorization extends BrowserSession {
  redirectPath: string;
}

@Injectable()
export class AuthService {
  private readonly logger = new Logger(AuthService.name);
  private readonly refreshTtlDays: number;

  constructor(
    private readonly database: DatabaseService,
    private readonly secureValues: SecureValuesService,
    private readonly accessTokens: AccessTokenService,
    private readonly config: ConfigService<Environment, true>,
    @Inject(GOOGLE_IDENTITY_PROVIDER)
    private readonly google: IdentityProviderPort,
  ) {
    this.refreshTtlDays = config.get('AUTH_REFRESH_TOKEN_TTL_DAYS', { infer: true });
  }

  async beginGoogleAuthorization(redirectPath = '/'): Promise<string> {
    const safeRedirectPath = this.normalizeRedirectPath(redirectPath);
    const state = this.secureValues.randomToken(32);
    const nonce = this.secureValues.randomToken(32);
    const codeVerifier = this.secureValues.randomToken(64);
    const now = new Date();

    await this.database.client.oAuthAuthorization.create({
      data: {
        codeVerifierCiphertext: this.secureValues.encrypt(codeVerifier),
        createdAt: now,
        expiresAt: new Date(now.getTime() + 10 * 60 * 1_000),
        id: uuidv7(),
        nonceHash: this.secureValues.hash(nonce),
        provider: IdentityProvider.GOOGLE,
        redirectPath: safeRedirectPath,
        stateHash: this.secureValues.hash(state),
      },
    });

    return this.google.authorizationUrl({
      codeChallenge: this.secureValues.pkceChallenge(codeVerifier),
      nonce,
      state,
    });
  }

  async completeGoogleAuthorization(
    code: string,
    state: string,
    fingerprint: ClientFingerprint,
  ): Promise<CompletedAuthorization> {
    const now = new Date();
    const stateHash = this.secureValues.hash(state);
    const authorization = await this.database.client.oAuthAuthorization.findUnique({
      where: { stateHash },
    });
    if (!authorization || authorization.expiresAt <= now || authorization.consumedAt) {
      throw new UnauthorizedException('The authorization transaction is invalid or expired.');
    }

    const claimed = await this.database.client.oAuthAuthorization.updateMany({
      data: { consumedAt: now },
      where: {
        consumedAt: null,
        expiresAt: { gt: now },
        id: authorization.id,
      },
    });
    if (claimed.count !== 1) {
      throw new UnauthorizedException('The authorization transaction was already consumed.');
    }

    const externalIdentity = await this.google.exchangeAuthorizationCode(
      code,
      this.secureValues.decrypt(authorization.codeVerifierCiphertext),
    );
    if (
      !externalIdentity.emailVerified ||
      !externalIdentity.nonce ||
      this.secureValues.hash(externalIdentity.nonce) !== authorization.nonceHash
    ) {
      throw new UnauthorizedException('The external identity could not be verified.');
    }

    const principal = await this.resolvePrincipal(externalIdentity);
    const session = await this.createSession(principal, fingerprint);
    return { ...session, redirectPath: authorization.redirectPath };
  }

  async refresh(refreshToken: string, fingerprint: ClientFingerprint): Promise<BrowserSession> {
    const tokenHash = this.secureValues.hash(refreshToken);
    const existing = await this.database.client.authSession.findUnique({
      include: { organization: true, user: true },
      where: { refreshTokenHash: tokenHash },
    });
    if (!existing) {
      throw new UnauthorizedException('The refresh session is invalid.');
    }

    const now = new Date();
    if (existing.rotatedAt || existing.revokedAt) {
      await this.revokeFamily(existing.familyId, existing.userId, 'auth.refresh_reuse_detected');
      throw new UnauthorizedException('The refresh session has been revoked.');
    }
    if (existing.expiresAt <= now || existing.user.status !== UserStatus.ACTIVE) {
      await this.revokeFamily(existing.familyId, existing.userId, 'auth.session_expired');
      throw new UnauthorizedException('The refresh session has expired.');
    }

    const membership = await this.database.client.organizationMembership.findUnique({
      where: {
        organizationId_userId: {
          organizationId: existing.organizationId,
          userId: existing.userId,
        },
      },
    });
    if (!membership || existing.organization.status !== OrganizationStatus.ACTIVE) {
      await this.revokeFamily(existing.familyId, existing.userId, 'auth.membership_inactive');
      throw new UnauthorizedException('The organization membership is not active.');
    }

    const nextRefreshToken = this.secureValues.randomToken(48);
    const nextSessionId = uuidv7();
    const expiresAt = new Date(now.getTime() + this.refreshTtlDays * 86_400_000);

    try {
      await this.database.client.$transaction(async (transaction) => {
        await transaction.authSession.create({
          data: {
            expiresAt,
            familyId: existing.familyId,
            id: nextSessionId,
            ipAddressHash: this.optionalFingerprintHash(fingerprint.ipAddress),
            organizationId: existing.organizationId,
            refreshTokenHash: this.secureValues.hash(nextRefreshToken),
            userAgentHash: this.optionalFingerprintHash(fingerprint.userAgent),
            userId: existing.userId,
          },
        });
        const rotated = await transaction.authSession.updateMany({
          data: {
            lastSeenAt: now,
            replacedBySessionId: nextSessionId,
            rotatedAt: now,
          },
          where: {
            id: existing.id,
            revokedAt: null,
            rotatedAt: null,
          },
        });
        if (rotated.count !== 1) {
          throw new Error('Concurrent refresh rotation detected.');
        }
      });
    } catch {
      await this.revokeFamily(existing.familyId, existing.userId, 'auth.refresh_race_detected');
      throw new UnauthorizedException('The refresh session could not be rotated.');
    }

    return this.buildBrowserSession(
      {
        avatarUrl: existing.user.avatarUrl,
        displayName: existing.user.displayName,
        email: existing.user.email,
        organizationId: existing.organization.id,
        organizationName: existing.organization.displayName,
        organizationSlug: existing.organization.slug,
        role: membership.role,
        userId: existing.user.id,
      },
      nextSessionId,
      nextRefreshToken,
    );
  }

  async logout(refreshToken: string | undefined): Promise<void> {
    if (!refreshToken) return;
    const session = await this.database.client.authSession.findUnique({
      select: { familyId: true, userId: true },
      where: { refreshTokenHash: this.secureValues.hash(refreshToken) },
    });
    if (session) {
      await this.revokeFamily(session.familyId, session.userId, 'auth.session_logged_out');
    }
  }

  async me(
    context: AccessContext,
  ): Promise<Omit<BrowserSession, 'accessToken' | 'expiresInSeconds' | 'refreshToken'>> {
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
      throw new UnauthorizedException('The account or organization is inactive.');
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

  private async resolvePrincipal(external: VerifiedExternalIdentity): Promise<Principal> {
    return this.database.client.$transaction(async (transaction) => {
      const candidate = await transaction.user.upsert({
        create: {
          avatarUrl: external.avatarUrl,
          displayName: external.displayName,
          email: external.email.toLowerCase(),
          id: uuidv7(),
        },
        update: {},
        where: { email: external.email.toLowerCase() },
      });
      const identity = await transaction.externalIdentity.upsert({
        create: {
          emailAtLink: external.email.toLowerCase(),
          id: uuidv7(),
          provider: IdentityProvider.GOOGLE,
          providerSubject: external.subject,
          userId: candidate.id,
        },
        update: {
          emailAtLink: external.email.toLowerCase(),
          lastLoginAt: new Date(),
        },
        where: {
          provider_providerSubject: {
            provider: IdentityProvider.GOOGLE,
            providerSubject: external.subject,
          },
        },
      });

      // Serialize first-login organization creation for this user. The external
      // identity is authoritative if a verified email was previously linked.
      await transaction.$queryRaw`SELECT id FROM users WHERE id = ${identity.userId}::uuid FOR UPDATE`;
      const user = await transaction.user.findUniqueOrThrow({ where: { id: identity.userId } });
      if (user.status !== UserStatus.ACTIVE) {
        throw new UnauthorizedException('The user account is inactive.');
      }

      let membership = await transaction.organizationMembership.findFirst({
        include: { organization: true },
        orderBy: { createdAt: 'asc' },
        where: {
          organization: { status: OrganizationStatus.ACTIVE },
          userId: user.id,
        },
      });
      if (!membership) {
        const organizationId = uuidv7();
        const displayName = `${user.displayName ?? user.email.split('@')[0] ?? 'VoiceVerse'} Studio`;
        const organization = await transaction.organization.create({
          data: {
            displayName: displayName.slice(0, 160),
            id: organizationId,
            slug: this.organizationSlug(displayName, organizationId),
          },
        });
        membership = {
          ...(await transaction.organizationMembership.create({
            data: {
              id: uuidv7(),
              organizationId,
              role: OrganizationRole.OWNER,
              userId: user.id,
            },
          })),
          organization,
        };
      }

      await transaction.auditLog.create({
        data: {
          action: 'auth.google.signed_in',
          actorUserId: user.id,
          id: uuidv7(),
          organizationId: membership.organizationId,
          resourceId: user.id,
          resourceType: 'user',
        },
      });

      return {
        avatarUrl: user.avatarUrl,
        displayName: user.displayName,
        email: user.email,
        organizationId: membership.organization.id,
        organizationName: membership.organization.displayName,
        organizationSlug: membership.organization.slug,
        role: membership.role,
        userId: user.id,
      };
    });
  }

  private async createSession(
    principal: Principal,
    fingerprint: ClientFingerprint,
  ): Promise<BrowserSession> {
    const refreshToken = this.secureValues.randomToken(48);
    const sessionId = uuidv7();
    const now = new Date();
    await this.database.client.authSession.create({
      data: {
        expiresAt: new Date(now.getTime() + this.refreshTtlDays * 86_400_000),
        familyId: uuidv7(),
        id: sessionId,
        ipAddressHash: this.optionalFingerprintHash(fingerprint.ipAddress),
        organizationId: principal.organizationId,
        refreshTokenHash: this.secureValues.hash(refreshToken),
        userAgentHash: this.optionalFingerprintHash(fingerprint.userAgent),
        userId: principal.userId,
      },
    });
    return this.buildBrowserSession(principal, sessionId, refreshToken);
  }

  private async buildBrowserSession(
    principal: Principal,
    sessionId: string,
    refreshToken: string,
  ): Promise<BrowserSession> {
    const accessToken = await this.accessTokens.issue({
      organizationId: principal.organizationId,
      role: principal.role,
      sessionId,
      userId: principal.userId,
    });
    return {
      accessToken,
      expiresInSeconds: this.accessTokens.expiresInSeconds,
      organization: {
        displayName: principal.organizationName,
        id: principal.organizationId,
        role: principal.role,
        slug: principal.organizationSlug,
      },
      refreshToken,
      user: {
        avatarUrl: principal.avatarUrl,
        displayName: principal.displayName,
        email: principal.email,
        id: principal.userId,
      },
    };
  }

  private async revokeFamily(familyId: string, userId: string, action: string): Promise<void> {
    const revokedAt = new Date();
    await this.database.client.$transaction([
      this.database.client.authSession.updateMany({
        data: { revokedAt },
        where: { familyId, revokedAt: null },
      }),
      this.database.client.auditLog.create({
        data: {
          action,
          actorUserId: userId,
          id: uuidv7(),
          resourceId: familyId,
          resourceType: 'auth_session_family',
        },
      }),
    ]);
    this.logger.warn({ action, familyId, userId }, 'Refresh session family revoked');
  }

  private normalizeRedirectPath(value: string): string {
    if (!value.startsWith('/') || value.startsWith('//') || value.includes('\\')) return '/';
    return value.slice(0, 512);
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

  private optionalFingerprintHash(value: string | undefined): string | undefined {
    return value ? this.secureValues.hash(value) : undefined;
  }
}
