import type { SchemaObject } from '@nestjs/swagger';
const str: SchemaObject = { type: 'string' };
const uuid: SchemaObject = { type: 'string', format: 'uuid' };
const date: SchemaObject = { type: 'string', format: 'date-time' };
const integer: SchemaObject = { type: 'integer' };
const bool: SchemaObject = { type: 'boolean' };
const nullable = (x: SchemaObject): SchemaObject => ({ ...x, nullable: true });
const object = (properties: Record<string, SchemaObject>): SchemaObject => ({
  type: 'object',
  additionalProperties: false,
  required: Object.keys(properties),
  properties,
});
export const businessAccessSchema = object({
  state: {
    type: 'string',
    enum: ['NONE', 'REVIEW_REQUIRED', 'ACTIVE', 'RESTRICTED'],
  },
  source: {
    type: 'string',
    nullable: true,
    enum: ['MANUAL_ADMIN', 'LEGACY_REVIEW', null],
  },
  restrictionReason: {
    type: 'string',
    nullable: true,
    enum: ['REVIEW_REQUIRED', 'REJECTED', 'REVOKED', null],
  },
  canApply: bool,
  canDowngrade: bool,
  reapplicationBlocked: bool,
});
export const businessApplicationSummarySchema = nullable(
  object({
    id: uuid,
    status: {
      type: 'string',
      enum: ['PENDING', 'APPROVED', 'REJECTED', 'WITHDRAWN'],
    },
    revision: integer,
  }),
);
const result = object({
  applicationStatus: nullable(str),
  applicationRevision: nullable(integer),
  accountRevision: nullable(integer),
  accessState: nullable(str),
  accountType: nullable(str),
  grantId: nullable(uuid),
  reapplicationBlocked: nullable(bool),
});
export const businessReceiptSchema = object({
  key: str,
  operation: {
    type: 'string',
    enum: [
      'SUBMIT',
      'WITHDRAW',
      'DECIDE',
      'REVOKE',
      'DOWNGRADE',
      'ALLOW_REAPPLICATION',
    ],
  },
  outcome: { type: 'string', enum: ['APPLIED', 'REJECTED', 'CLOSED'] },
  code: nullable(str),
  resourceId: nullable(uuid),
  committedAt: date,
  result,
});
export const businessAttemptSchema = object({
  state: {
    type: 'string',
    enum: ['NOT_OBSERVED', 'APPLIED', 'REJECTED', 'CLOSED'],
  },
  receipt: nullable(businessReceiptSchema),
});
export const businessErrorSchema = object({
  statusCode: integer,
  code: str,
  requestId: str,
  message: str,
  errors: { type: 'array', items: str },
  timestamp: date,
  path: str,
  receipt: nullable(businessReceiptSchema),
});
export const applicationSchema = object({
  id: uuid,
  status: {
    type: 'string',
    enum: ['PENDING', 'APPROVED', 'REJECTED', 'WITHDRAWN'],
  },
  revision: integer,
  submittedAt: date,
  resolvedAt: nullable(date),
  snapshot: object({
    businessName: str,
    activity: str,
    city: str,
    estimatedDeliveryVolume: str,
    note: nullable(str),
  }),
  publicReason: nullable(str),
});
export const administrationSchema = object({
  customerAccount: object({
    id: uuid,
    type: { type: 'string', enum: ['PERSONAL', 'BUSINESS'] },
    revision: integer,
    active: bool,
    verifiedEmail: nullable(str),
    businessAccess: businessAccessSchema,
    activeRequestCount: integer,
  }),
  businessAccessAdministration: object({
    activeGrant: nullable(
      object({ id: uuid, applicationId: uuid, grantedAt: date }),
    ),
    lastAdministrativeRevocation: nullable(
      object({
        grantId: uuid,
        revokedAt: date,
        publicReason: nullable(str),
        reapplicationAllowedAt: nullable(date),
      }),
    ),
    canRevoke: bool,
    canAllowReapplication: bool,
  }),
});
export const adminApplicationSchema = object({
  ...applicationSchema.properties!,
  ...administrationSchema.properties!,
  decisionActorId: nullable(uuid),
  internalNote: nullable(str),
});
export const applicationPageSchema = (admin = false): SchemaObject =>
  object({
    items: {
      type: 'array',
      items: admin ? adminApplicationSchema : applicationSchema,
    },
    total: integer,
    page: integer,
    pageSize: integer,
  });
