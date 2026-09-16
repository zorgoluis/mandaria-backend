import type { UserInvitationStatus } from '@prisma/client';
import { DomainException } from '../common/domain-error.js';
import { hashSecret, newSecret } from '../common/security.js';

export const INVITABLE_ROLES = ['PROVIDER_ADMIN', 'DRIVER'] as const;
export type InvitableRole = (typeof INVITABLE_ROLES)[number];
/** EXPIRED is derived from expiresAt, never persisted. */
export const INVITATION_STATUSES = [
  'PENDING',
  'EXPIRED',
  'ACCEPTED',
  'REVOKED',
] as const;
export type InvitationEffectiveStatus = (typeof INVITATION_STATUSES)[number];
export const USER_ACCOUNT_STATUSES = ['INVITED', 'ACTIVE', 'DISABLED'] as const;
export type UserAccountStatus = (typeof USER_ACCOUNT_STATUSES)[number];

export const INVITATION_ERRORS = {
  USER_ALREADY_ACTIVE: 409,
  USER_INVITATION_PENDING: 409,
  USER_DISABLED: 409,
  PROVIDER_DRIVER_LIMIT_REACHED: 409,
  INVITATION_NOT_PENDING: 409,
  INVITATION_RESEND_COOLDOWN: 429,
  INVITATION_TOKEN_INVALID: 400,
  INVITATION_EXPIRED: 410,
  INVITATION_REVOKED: 410,
  INVITATION_ALREADY_ACCEPTED: 409,
  ACCOUNT_NOT_ACTIVATABLE: 409,
  MAIL_NOT_CONFIGURED: 503,
} as const;
export type InvitationErrorCode = keyof typeof INVITATION_ERRORS;
export const invitationError = (code: InvitationErrorCode, message: string) =>
  new DomainException(code, INVITATION_ERRORS[code], message);

/**
 * Activation token: 256 random bits as base64url (43 chars). Only its SHA-256 is stored; a
 * fast hash is sufficient because the token is high-entropy, unlike a password.
 */
export function newInvitationToken() {
  const token = newSecret();
  return { token, tokenHash: hashSecret(token) };
}

export const invitationExpiry = (issuedAt: Date, ttlHours: number) =>
  new Date(issuedAt.getTime() + ttlHours * 3_600_000);

/** A PENDING invitation stops being valid exactly at expiresAt (now >= expiresAt). */
export function effectiveInvitationStatus(
  invitation: { status: UserInvitationStatus; expiresAt: Date },
  now = new Date(),
): InvitationEffectiveStatus {
  return invitation.status === 'PENDING' && now >= invitation.expiresAt
    ? 'EXPIRED'
    : invitation.status;
}

const ACTIVATION_FAILURES: Record<
  Exclude<InvitationEffectiveStatus, 'PENDING'>,
  [InvitationErrorCode, string]
> = {
  EXPIRED: ['INVITATION_EXPIRED', 'Invitation has expired'],
  REVOKED: ['INVITATION_REVOKED', 'Invitation has been revoked'],
  ACCEPTED: ['INVITATION_ALREADY_ACCEPTED', 'Invitation was already used'],
};
/** Throws the activation error for an unknown or no-longer-valid invitation. */
export function assertActivatable(
  invitation: { status: UserInvitationStatus; expiresAt: Date } | null,
  now = new Date(),
) {
  if (!invitation)
    throw invitationError(
      'INVITATION_TOKEN_INVALID',
      'Invalid invitation token',
    );
  const status = effectiveInvitationStatus(invitation, now);
  if (status !== 'PENDING')
    throw invitationError(...ACTIVATION_FAILURES[status]);
}

/**
 * Account state without a dedicated column: active → ACTIVE; inactive and never given a
 * password → INVITED; inactive with a password → DISABLED.
 */
export const userAccountStatus = (user: {
  active: boolean;
  hasPassword: boolean;
}): UserAccountStatus =>
  user.active ? 'ACTIVE' : user.hasPassword ? 'DISABLED' : 'INVITED';

/** Who may invite whom. PROVIDER_ADMIN is further limited to providers of its memberships. */
export const INVITATION_ROLE_MATRIX: Record<string, readonly InvitableRole[]> =
  {
    SUPER_ADMIN: ['PROVIDER_ADMIN', 'DRIVER'],
    PROVIDER_ADMIN: ['DRIVER'],
    DRIVER: [],
  };
export const canInvite = (actorRole: string, role: InvitableRole) =>
  (INVITATION_ROLE_MATRIX[actorRole] ?? []).includes(role);
