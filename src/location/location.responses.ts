import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
export class LocationSampleResponse {
  @ApiProperty() latitude!: number;
  @ApiProperty() longitude!: number;
  @ApiProperty() accuracyMeters!: number;
  @ApiProperty({ format: 'date-time' }) capturedAt!: string;
  @ApiProperty({ format: 'date-time' }) receivedAt!: string;
  @ApiProperty({ format: 'date-time' }) freshUntil!: string;
  @ApiProperty({ format: 'date-time' }) eraseAfter!: string;
}
export class LocationProgressResponse {
  @ApiProperty({ type: String }) publicVersion!: string;
  @ApiProperty({ type: String }) status!: string;
  @ApiProperty({ enum: ['LEGACY', 'DETAILED'], nullable: true }) trackingMode!:
    string | null;
  @ApiProperty({ enum: ['ACTIVE', 'ENDED', 'NONE'] }) assignmentState!: string;
  @ApiProperty({ type: String, nullable: true }) phase!: string | null;
  @ApiProperty() attentionRequired!: boolean;
  @ApiProperty({
    type: 'object',
    nullable: true,
    properties: {
      type: { type: 'string' },
      occurredAt: { type: 'string', format: 'date-time' },
    },
  })
  terminalOutcome!: object | null;
}
export class LocationPositionResponse {
  @ApiProperty({ type: String }) locationVersion!: string;
  @ApiProperty({ type: String }) assignmentGeneration!: string;
  @ApiProperty({ enum: ['AVAILABLE', 'UNAVAILABLE'] }) availability!: string;
  @ApiProperty({ type: String, nullable: true }) unavailableReason!:
    string | null;
  @ApiProperty({ type: LocationSampleResponse, nullable: true })
  sample!: LocationSampleResponse | null;
}
export class LocationObservationResponse {
  @ApiProperty({ format: 'date-time' }) evaluatedAt!: string;
  @ApiProperty({ enum: ['RECENT', 'STALE', 'UNAVAILABLE'] }) freshness!: string;
}
export class LocationViewResponse {
  @ApiProperty() publicId!: string;
  @ApiProperty({ type: LocationProgressResponse })
  progress!: LocationProgressResponse;
  @ApiProperty({ type: LocationPositionResponse })
  location!: LocationPositionResponse;
  @ApiProperty({ type: LocationObservationResponse })
  observation!: LocationObservationResponse;
}
export class TrackingLinkResponse {
  @ApiProperty({ type: String }) linkRevision!: string;
  @ApiProperty({ type: String, nullable: true }) linkId!: string | null;
  @ApiProperty({ enum: ['NONE', 'ACTIVE', 'EXPIRED', 'REVOKED', 'TERMINAL'] })
  status!: string;
  @ApiProperty({ type: String, format: 'date-time', nullable: true })
  createdAt!: string | null;
  @ApiProperty({ type: String, format: 'date-time', nullable: true })
  expiresAt!: string | null;
  @ApiProperty({ type: String, format: 'date-time', nullable: true })
  terminalAccessUntil!: string | null;
  @ApiPropertyOptional() secretAvailable?: boolean;
  @ApiPropertyOptional({ type: String }) url?: string;
}
export class TrackingAttemptResponse {
  @ApiProperty({
    enum: [
      'APPLIED_SECRET_UNAVAILABLE',
      'APPLIED_REVOKED',
      'PENDING_OR_UNKNOWN',
      'SUPERSEDED',
    ],
  })
  state!: string;
  @ApiProperty({ type: String }) linkRevision!: string;
  @ApiProperty({ type: String, nullable: true }) currentLinkId!: string | null;
  @ApiProperty({ enum: [false] }) secretAvailable!: boolean;
}
export class LocationStreamResponse {
  @ApiProperty({ type: String, nullable: true }) streamId!: string | null;
  @ApiProperty({ type: String }) streamRevision!: string;
  @ApiProperty() lastSequence!: number;
  @ApiProperty() canPublish!: boolean;
}
export class LocationAckResponse {
  @ApiProperty({ enum: ['ACCEPTED', 'DUPLICATE', 'SUPERSEDED'] })
  outcome!: string;
  @ApiProperty({ type: String }) streamRevision!: string;
  @ApiProperty({ type: Number, nullable: true }) acknowledgedSequence!:
    number | null;
  @ApiProperty() currentSequence!: number;
  @ApiProperty({ type: String }) locationVersion!: string;
}
