import { randomInt } from 'node:crypto';
import { HttpStatus } from '@nestjs/common';
import type {
  PartnerApplicationStatus,
  PartnerApplicationType,
} from '@prisma/client';
import { DomainException } from '../common/domain-error.js';
import { formatPublicId } from '../common/public-id.js';

export const PARTNER_APPLICATION_TYPES = ['INDIVIDUAL', 'FLEET'] as const;
export const PARTNER_APPLICATION_STATUSES = [
  'RECEIVED',
  'CONTACTED',
  'APPROVED',
  'REJECTED',
  'DISCARDED',
] as const;
/** Vehicle types offered by the landing; VAN/OTHER exist in VehicleType but are not offered. */
export const PARTNER_VEHICLE_TYPES = [
  'BICYCLE',
  'MOTORCYCLE',
  'CAR',
  'PICKUP',
  'TRUCK',
] as const;
/** Open applications absorb new submissions with the same phone or email in this window. */
export const DUPLICATE_WINDOW_DAYS = 30;
export const OPEN_STATUSES: PartnerApplicationStatus[] = [
  'RECEIVED',
  'CONTACTED',
];

/** Contract §6: allowed transitions; REJECTED and DISCARDED are terminal. */
export const PARTNER_APPLICATION_TRANSITIONS: Record<
  PartnerApplicationStatus,
  readonly PartnerApplicationStatus[]
> = {
  RECEIVED: ['CONTACTED', 'REJECTED', 'DISCARDED'],
  CONTACTED: ['APPROVED', 'REJECTED', 'DISCARDED'],
  APPROVED: ['REJECTED'],
  REJECTED: [],
  DISCARDED: [],
};

export const PARTNER_APPLICATION_ERRORS = {
  PARTNER_APPLICATION_NOT_FOUND: HttpStatus.NOT_FOUND,
  PARTNER_APPLICATION_INVALID_TRANSITION: HttpStatus.CONFLICT,
  PARTNER_APPLICATION_LINK_INVALID: HttpStatus.CONFLICT,
} as const;
export type PartnerApplicationErrorCode =
  keyof typeof PARTNER_APPLICATION_ERRORS;
export const partnerApplicationError = (
  code: PartnerApplicationErrorCode,
  message: string,
) => new DomainException(code, PARTNER_APPLICATION_ERRORS[code], message);

export const notFound = () =>
  partnerApplicationError(
    'PARTNER_APPLICATION_NOT_FOUND',
    'Partner application not found',
  );

/** Accepts sOc-000123; returns the canonical SOC-000123 or null. */
export function normalizeReference(value: string) {
  return /^SOC-\d{6,12}$/i.test(value) ? value.toUpperCase() : null;
}

/**
 * Honeypot: any non-empty value (or a non-string value) in `website` means a bot filled the hidden
 * field. Whitespace-only counts as empty, as some autofill engines insert it.
 */
export function isHoneypotFilled(body: unknown) {
  if (!body || typeof body !== 'object' || !('website' in body)) return false;
  const value = (body as { website?: unknown }).website;
  if (value === undefined || value === null) return false;
  return typeof value !== 'string' || value.trim() !== '';
}

/** Well-formed, never persisted reference for the honeypot answer. */
export const decoyReference = () =>
  formatPublicId('SOC', randomInt(1, 1_000_000));

type ReviewState = {
  status: PartnerApplicationStatus;
  reviewNote: string | null;
  providerId: string | null;
  invitationId: string | null;
};

/**
 * Validates a status change and returns the note to store. A missing reviewNote keeps the stored
 * one. APPROVED needs a note or a link (links can only be added once approved, so in practice a
 * note); APPROVED -> REJECTED needs a new note in the same request.
 */
export function assertTransition(
  current: ReviewState,
  target: PartnerApplicationStatus,
  reviewNote: string | undefined,
) {
  if (!PARTNER_APPLICATION_TRANSITIONS[current.status].includes(target))
    throw partnerApplicationError(
      'PARTNER_APPLICATION_INVALID_TRANSITION',
      `Cannot change a ${current.status} application to ${target}`,
    );
  const note = reviewNote ?? current.reviewNote;
  if (
    target === 'APPROVED' &&
    !note &&
    !current.providerId &&
    !current.invitationId
  )
    throw partnerApplicationError(
      'PARTNER_APPLICATION_INVALID_TRANSITION',
      'APPROVED requires a reviewNote or a provider/invitation link',
    );
  if (current.status === 'APPROVED' && target === 'REJECTED' && !reviewNote)
    throw partnerApplicationError(
      'PARTNER_APPLICATION_INVALID_TRANSITION',
      'Rejecting an APPROVED application requires a reviewNote',
    );
  return note;
}

type LinkTarget = {
  type: PartnerApplicationType;
  status: PartnerApplicationStatus;
  email: string;
  providerId: string | null;
  invitationId: string | null;
};
type LinkedProvider = { id: string; type: string } | null;
type LinkedInvitation = {
  id: string;
  email: string;
  providerId: string;
} | null;

const linkError = (message: string) =>
  partnerApplicationError('PARTNER_APPLICATION_LINK_INVALID', message);

/**
 * Links are only recorded on APPROVED applications. A provider must exist, be FLEET and belong to
 * a FLEET application; an invitation must exist and target the application's email. When both are
 * known (now or from a previous link) the invitation must be for that provider.
 *
 * `provider` is the requested provider; `invitation` is the effective one (requested, otherwise the
 * one already linked) so a later provider link is checked against an earlier invitation link.
 */
export function assertLinks(
  application: LinkTarget,
  requested: { providerId?: string; invitationId?: string },
  provider: LinkedProvider,
  invitation: LinkedInvitation,
) {
  if (application.status !== 'APPROVED')
    throw linkError('Links can only be recorded on APPROVED applications');
  if (requested.providerId !== undefined) {
    if (application.type !== 'FLEET')
      throw linkError('Only FLEET applications link a provider');
    if (!provider) throw linkError('Provider does not exist');
    if (provider.type !== 'FLEET')
      throw linkError('Linked provider must be of type FLEET');
  }
  if (requested.invitationId !== undefined) {
    if (!invitation) throw linkError('Invitation does not exist');
    if (invitation.email !== application.email)
      throw linkError('Invitation email does not match the application');
  }
  const providerId = requested.providerId ?? application.providerId;
  if (
    application.type === 'FLEET' &&
    providerId &&
    invitation &&
    invitation.providerId !== providerId
  )
    throw linkError('Invitation belongs to a different provider');
  return {
    providerId,
    invitationId: requested.invitationId ?? application.invitationId,
  };
}
