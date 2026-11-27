export interface AuthUser {
  id: string;
  email: string;
  role: 'participant' | 'admin';
  isBlocked: boolean;
  humanVerifiedAt: Date | null;
  displayName: string;
  avatarUrl: string | null;
}

export type AuthRequest = import('express').Request & { user?: AuthUser | null };
