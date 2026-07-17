export const EXTERNAL_ACCESS_TOKEN_VERIFIER = Symbol('EXTERNAL_ACCESS_TOKEN_VERIFIER');

/** Claims normalized at the infrastructure boundary after signature verification. */
export interface VerifiedExternalAccessToken {
  subject: string;
  sessionId: string;
  email: string;
  provider: string;
  displayName: string | null;
  avatarUrl: string | null;
}

export interface ExternalAccessTokenVerifierPort {
  verify(token: string): Promise<VerifiedExternalAccessToken>;
}
