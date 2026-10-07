import { ApiOkResponse, ApiCreatedResponse } from '@nestjs/swagger';
import { ApiErrorDescriptions } from '../common/api-errors.decorator.js';
import {
  LocationViewResponse,
  TrackingLinkResponse,
  TrackingAttemptResponse,
  LocationStreamResponse,
  LocationAckResponse,
} from './location.responses.js';
import {
  Body,
  Controller,
  Get,
  Header,
  Headers,
  HttpCode,
  Param,
  ParseUUIDPipe,
  Post,
  Put,
  Query,
  Req,
  Res,
  UseGuards,
} from '@nestjs/common';
import {
  ApiBearerAuth,
  ApiHeader,
  ApiOperation,
  ApiTags,
  ApiSecurity,
} from '@nestjs/swagger';
import type { Request, Response } from 'express';
import {
  AccessGuard,
  Roles,
  RolesGuard,
  type AuthenticatedRequest,
} from '../auth/auth.guards.js';
import {
  IntegrationGuard,
  type IntegrationRequest,
} from '../integrations/integration.guard.js';
import {
  IntegrationScopes,
  IntegrationScopesGuard,
} from '../integrations/integration-scopes.js';
import { CustomersService } from '../customers/customers.service.js';
import { LocationService } from './location.service.js';
import {
  LocationSampleDto,
  OpenLocationStreamDto,
  TrackingLinkDto,
  TrackingLinkAttemptDto,
} from './location.dto.js';
import { parsePublicId } from '../delivery-requests/delivery-requests.controller.js';
const keyHeader = () =>
  ApiHeader({
    name: 'Idempotency-Key',
    required: true,
    description:
      'UUID por intención. Conservar clave, operación y revisión; nunca guardar secretos ni cuerpos.',
  });
const trackingErrors = () =>
  ApiErrorDescriptions({
    400: 'VALIDATION_ERROR. Campos, revisión o clave inválidos.',
    401: 'Autenticación inválida.',
    403: 'Rol o scopes insuficientes.',
    404: 'Recurso inexistente, ajeno o SHARED_TRACKING_UNAVAILABLE.',
    409: 'LOCATION_NOT_ACTIVE, LOCATION_PHASE_NOT_ALLOWED, LOCATION_STREAM_REPLACED, LOCATION_STREAM_REVISION_CONFLICT, LOCATION_SAMPLE_CONFLICT, LINK_REVISION_CONFLICT, LINK_NOT_ISSUABLE o IDEMPOTENCY_KEY_REUSED.',
    422: 'LOCATION_CAPTURE_TIME_INVALID o LOCATION_ACCURACY_INSUFFICIENT.',
    429: 'TRACKING_RATE_LIMITED. Respetar Retry-After.',
    503: 'TRACKING_DISABLED o TRACKING_TEMPORARILY_UNAVAILABLE.',
  });
@ApiTags('Driver location')
@trackingErrors()
@ApiBearerAuth()
@UseGuards(AccessGuard, RolesGuard)
@Roles('DRIVER')
@Controller('driver/dispatches/:dispatchId/assignments/:assignmentId')
export class DriverLocationController {
  constructor(private readonly location: LocationService) {}
  @ApiOkResponse({ type: LocationStreamResponse })
  @Get('location-stream')
  @Header('Cache-Control', 'private, no-store')
  @ApiOperation({
    summary: 'Consultar sesión GPS de la asignación propia vigente',
  })
  stream(
    @Param('dispatchId', ParseUUIDPipe) d: string,
    @Param('assignmentId', ParseUUIDPipe) a: string,
    @Req() r: AuthenticatedRequest,
  ) {
    return this.location.stream(d, a, r.user.id);
  }
  @ApiOkResponse({ type: LocationStreamResponse })
  @Post('location-stream')
  @HttpCode(200)
  @keyHeader()
  @ApiOperation({
    summary: 'Iniciar sesión GPS mediante CAS; sustituye dispositivo anterior',
  })
  open(
    @Param('dispatchId', ParseUUIDPipe) d: string,
    @Param('assignmentId', ParseUUIDPipe) a: string,
    @Req() r: AuthenticatedRequest,
    @Body() b: OpenLocationStreamDto,
    @Headers('idempotency-key') k: string | undefined,
  ) {
    return this.location.stream(d, a, r.user.id, {
      expected: b.expectedStreamRevision,
      key: k,
    });
  }
  @ApiOkResponse({ type: LocationAckResponse })
  @Put('location')
  @HttpCode(200)
  @ApiOperation({
    summary:
      'Publicar última muestra GPS propia; no confirma hitos, custodia ni cobro',
  })
  publish(
    @Param('dispatchId', ParseUUIDPipe) d: string,
    @Param('assignmentId', ParseUUIDPipe) a: string,
    @Req() r: AuthenticatedRequest,
    @Body() b: LocationSampleDto,
  ) {
    return this.location.publish(d, a, r.user.id, b);
  }
}

@ApiTags('Customer location')
@trackingErrors()
@ApiBearerAuth()
@UseGuards(AccessGuard)
@Controller('customer/delivery-requests')
export class CustomerLocationController {
  constructor(
    private readonly location: LocationService,
    private readonly customers: CustomersService,
  ) {}
  @ApiOkResponse({ type: LocationViewResponse })
  @Get(':publicId/location')
  @Header('Cache-Control', 'private, no-store')
  @ApiOperation({
    summary: 'Consultar última ubicación autorizada',
    description:
      'GPS desde TO_PICKUP para titular. locationVersion ordena ubicación por MDR; publicVersion ordena progreso. Incidencia y terminal ocultan coordenadas. No es prueba de entrega ni cobro.',
  })
  async view(@Param('publicId') id: string, @Req() r: AuthenticatedRequest) {
    return this.location.ownerView(parsePublicId(id), {
      kind: 'CUSTOMER' as const,
      id: (await this.customers.account(r.user.id)).id,
    });
  }
  @ApiOkResponse({ type: TrackingLinkResponse })
  @Get(':publicId/tracking-link')
  @Header('Cache-Control', 'private, no-store')
  @ApiOperation({
    summary: 'Consultar metadata del enlace sin recuperar secreto',
  })
  async metadata(
    @Param('publicId') id: string,
    @Req() r: AuthenticatedRequest,
  ) {
    return this.location.link(
      parsePublicId(id),
      {
        kind: 'CUSTOMER' as const,
        id: (await this.customers.account(r.user.id)).id,
      },
      r.user.id,
    );
  }
  @ApiOkResponse({ type: TrackingLinkResponse })
  @Post(':publicId/tracking-link')
  @ApiCreatedResponse({ type: TrackingLinkResponse })
  @HttpCode(200)
  @keyHeader()
  @ApiOperation({
    summary: 'Emitir o sustituir enlace temporal',
    description:
      'Secreto sólo en primera respuesta; replay sin secreto. TTL absoluto 24h. URL de interfaz con fragmento; nunca usar token en URL API. Tras incertidumbre consultar intento; no emitir automáticamente.',
  })
  async issue(
    @Param('publicId') id: string,
    @Req() r: AuthenticatedRequest,
    @Res({ passthrough: true }) res: Response,
    @Body() b: TrackingLinkDto,
    @Headers('idempotency-key') k: string | undefined,
  ) {
    const result = await this.location.link(
      parsePublicId(id),
      {
        kind: 'CUSTOMER' as const,
        id: (await this.customers.account(r.user.id)).id,
      },
      r.user.id,
      { operation: 'ISSUE', expected: b.expectedLinkRevision, key: k },
    );
    res.status(
      'secretAvailable' in result && result.secretAvailable ? 201 : 200,
    );
    return result;
  }
  @ApiOkResponse({ type: TrackingLinkResponse })
  @Post(':publicId/tracking-link/revoke')
  @HttpCode(200)
  @keyHeader()
  @ApiOperation({
    summary: 'Revocar y cerrar técnicamente emisiones anteriores',
    description:
      'CAS con revisión consultada. Si gana frente a emisión tardía, ésta no puede aplicar. Si recibe 409 consultar y confirmar nueva revocación; no asumir cierre. No modifica entrega ni pagos.',
  })
  async revoke(
    @Param('publicId') id: string,
    @Req() r: AuthenticatedRequest,
    @Body() b: TrackingLinkDto,
    @Headers('idempotency-key') k: string | undefined,
  ) {
    return this.location.link(
      parsePublicId(id),
      {
        kind: 'CUSTOMER' as const,
        id: (await this.customers.account(r.user.id)).id,
      },
      r.user.id,
      { operation: 'REVOKE', expected: b.expectedLinkRevision, key: k },
    );
  }
  @ApiOkResponse({ type: TrackingAttemptResponse })
  @Get(':publicId/tracking-link/attempt')
  @Header('Cache-Control', 'private, no-store')
  @keyHeader()
  @ApiOperation({
    summary: 'Reconciliar emisión o revocación sin cuerpo original',
    description:
      'APPLIED_SECRET_UNAVAILABLE, APPLIED_REVOKED, PENDING_OR_UNKNOWN o SUPERSEDED. SUPERSEDED impide efecto futuro con esa revisión; no acredita que nunca se emitió un enlace ni que el actual esté revocado. GET no cierra.',
  })
  async attempt(
    @Param('publicId') id: string,
    @Req() r: AuthenticatedRequest,
    @Query() b: TrackingLinkAttemptDto,
    @Headers('idempotency-key') k: string | undefined,
  ) {
    return this.location.link(
      parsePublicId(id),
      {
        kind: 'CUSTOMER' as const,
        id: (await this.customers.account(r.user.id)).id,
      },
      r.user.id,
      {
        operation: 'ATTEMPT',
        attemptOperation: b.operation,
        expected: b.expectedLinkRevision,
        key: k,
      },
    );
  }
}

@ApiTags('B2b location')
@trackingErrors()
@ApiBearerAuth('integration-bearer')
@UseGuards(IntegrationGuard, IntegrationScopesGuard)
@Controller('delivery-requests')
export class B2bLocationController {
  constructor(private readonly location: LocationService) {}
  @ApiOkResponse({ type: LocationViewResponse })
  @Get(':publicId/location')
  @Header('Cache-Control', 'private, no-store')
  @IntegrationScopes('deliveries:read', 'deliveries:location:read')
  @ApiOperation({
    summary: 'Consultar última ubicación autorizada',
    description:
      'GPS desde TO_PICKUP para titular. locationVersion ordena ubicación por MDR; publicVersion ordena progreso. Incidencia y terminal ocultan coordenadas. No es prueba de entrega ni cobro.',
  })
  async view(@Param('publicId') id: string, @Req() r: IntegrationRequest) {
    return this.location.ownerView(parsePublicId(id), {
      kind: 'INTEGRATION' as const,
      id: r.integration.id,
    });
  }
  @ApiOkResponse({ type: TrackingLinkResponse })
  @Get(':publicId/tracking-link')
  @Header('Cache-Control', 'private, no-store')
  @IntegrationScopes('deliveries:read', 'deliveries:tracking-links:manage')
  @ApiOperation({
    summary: 'Consultar metadata del enlace sin recuperar secreto',
  })
  async metadata(@Param('publicId') id: string, @Req() r: IntegrationRequest) {
    return this.location.link(
      parsePublicId(id),
      { kind: 'INTEGRATION' as const, id: r.integration.id },
      r.integration.authentication.credentialId,
    );
  }
  @ApiOkResponse({ type: TrackingLinkResponse })
  @Post(':publicId/tracking-link')
  @ApiCreatedResponse({ type: TrackingLinkResponse })
  @HttpCode(200)
  @keyHeader()
  @IntegrationScopes('deliveries:read', 'deliveries:tracking-links:manage')
  @ApiOperation({
    summary: 'Emitir o sustituir enlace temporal',
    description:
      'Secreto sólo en primera respuesta; replay sin secreto. TTL absoluto 24h. URL de interfaz con fragmento; nunca usar token en URL API. Tras incertidumbre consultar intento; no emitir automáticamente.',
  })
  async issue(
    @Param('publicId') id: string,
    @Req() r: IntegrationRequest,
    @Res({ passthrough: true }) res: Response,
    @Body() b: TrackingLinkDto,
    @Headers('idempotency-key') k: string | undefined,
  ) {
    const result = await this.location.link(
      parsePublicId(id),
      { kind: 'INTEGRATION' as const, id: r.integration.id },
      r.integration.authentication.credentialId,
      { operation: 'ISSUE', expected: b.expectedLinkRevision, key: k },
    );
    res.status(
      'secretAvailable' in result && result.secretAvailable ? 201 : 200,
    );
    return result;
  }
  @ApiOkResponse({ type: TrackingLinkResponse })
  @Post(':publicId/tracking-link/revoke')
  @HttpCode(200)
  @keyHeader()
  @IntegrationScopes('deliveries:read', 'deliveries:tracking-links:manage')
  @ApiOperation({
    summary: 'Revocar y cerrar técnicamente emisiones anteriores',
    description:
      'CAS con revisión consultada. Si gana frente a emisión tardía, ésta no puede aplicar. Si recibe 409 consultar y confirmar nueva revocación; no asumir cierre. No modifica entrega ni pagos.',
  })
  async revoke(
    @Param('publicId') id: string,
    @Req() r: IntegrationRequest,
    @Body() b: TrackingLinkDto,
    @Headers('idempotency-key') k: string | undefined,
  ) {
    return this.location.link(
      parsePublicId(id),
      { kind: 'INTEGRATION' as const, id: r.integration.id },
      r.integration.authentication.credentialId,
      { operation: 'REVOKE', expected: b.expectedLinkRevision, key: k },
    );
  }
  @ApiOkResponse({ type: TrackingAttemptResponse })
  @Get(':publicId/tracking-link/attempt')
  @Header('Cache-Control', 'private, no-store')
  @keyHeader()
  @IntegrationScopes('deliveries:read', 'deliveries:tracking-links:manage')
  @ApiOperation({
    summary: 'Reconciliar emisión o revocación sin cuerpo original',
    description:
      'APPLIED_SECRET_UNAVAILABLE, APPLIED_REVOKED, PENDING_OR_UNKNOWN o SUPERSEDED. SUPERSEDED impide efecto futuro con esa revisión; no acredita que nunca se emitió un enlace ni que el actual esté revocado. GET no cierra.',
  })
  async attempt(
    @Param('publicId') id: string,
    @Req() r: IntegrationRequest,
    @Query() b: TrackingLinkAttemptDto,
    @Headers('idempotency-key') k: string | undefined,
  ) {
    return this.location.link(
      parsePublicId(id),
      { kind: 'INTEGRATION' as const, id: r.integration.id },
      r.integration.authentication.credentialId,
      {
        operation: 'ATTEMPT',
        attemptOperation: b.operation,
        expected: b.expectedLinkRevision,
        key: k,
      },
    );
  }
}

@ApiTags('Recipient tracking')
@trackingErrors()
@ApiSecurity('tracking-link')
@Controller('shared')
export class SharedLocationController {
  constructor(private readonly location: LocationService) {}
  @ApiOkResponse({ type: LocationViewResponse })
  @Get('delivery-tracking')
  @Header('Cache-Control', 'private, no-store')
  @ApiOperation({
    summary: 'Consultar seguimiento mínimo del destinatario',
    description:
      'Authorization: Tracking selector.secret. GPS desde PICKED_UP; incidencia oculta posición. Terminal sin GPS máximo 1h sin extender TTL original. Token inválido/expirado/revocado: 404 genérico.',
  })
  shared(@Req() r: Request) {
    return this.location.shared(r.headers.authorization, r.ip ?? 'unknown');
  }
}
