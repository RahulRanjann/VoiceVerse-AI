import type { OrganizationRole } from '@voiceverse/database';

export interface AccessContext {
  userId: string;
  organizationId: string;
  role: OrganizationRole;
  sessionId: string;
}

export interface AuthenticatedRequest {
  auth: AccessContext;
}
