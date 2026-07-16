export const GOOGLE_IDENTITY_PROVIDER = Symbol('GOOGLE_IDENTITY_PROVIDER');

export interface IdentityAuthorizationRequest {
  state: string;
  nonce: string;
  codeChallenge: string;
}

export interface VerifiedExternalIdentity {
  subject: string;
  email: string;
  emailVerified: boolean;
  displayName?: string;
  avatarUrl?: string;
  nonce?: string;
}

export interface IdentityProviderPort {
  authorizationUrl(request: IdentityAuthorizationRequest): string;
  exchangeAuthorizationCode(code: string, codeVerifier: string): Promise<VerifiedExternalIdentity>;
}
