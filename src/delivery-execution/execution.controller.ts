import { ApiOkResponse, ApiQuery } from '@nestjs/swagger';
import { ResolutionAttemptResponse } from './execution.responses.js';
import { ProviderAdvanceAttemptResponse } from './execution.responses.js';
import {
  DriverAttemptResponse,
  DriverCompletionResponse,
} from './execution.responses.js';
import { ApiErrors } from '../common/api-errors.decorator.js';
import {
  ExecutionDetailResponse,
  IncidentPageResponse,
  IncidentDetailResponse,
  TransferCandidatePageResponse,
} from './execution.responses.js';
import { ExecutionContract } from './execution.responses.js';
import {
  Body,
  Controller,
  Get,
  Headers,
  Header,
  HttpCode,
  Param,
  ParseUUIDPipe,
  Post,
  Query,
  Req,
  UseGuards,
} from '@nestjs/common';
import {
  ApiBearerAuth,
  ApiHeader,
  ApiOperation,
  ApiTags,
} from '@nestjs/swagger';
import { AccessGuard, Roles, RolesGuard } from '../auth/auth.guards.js';
import type { AuthenticatedRequest } from '../auth/auth.guards.js';
import {
  CurrentProvider,
  ProviderMembershipGuard,
} from '../providers/provider-membership.guard.js';
import type { ProviderProfile } from '../providers/provider-membership.guard.js';
import { ExecutionService } from './execution.service.js';
import {
  AdvanceExecutionDto,
  ReportCustodyIncidentDto,
  ResolveCustodyIncidentDto,
  IncidentQueryDto,
  TransferCandidatesQueryDto,
  ProviderExecutionQueryDto,
  ExecutionCommandDto,
  DriverAttemptParamsDto,
} from './execution.dto.js';
import { PrismaService } from '../prisma/prisma.service.js';
import { pageResult, PaginationQueryDto } from '../common/pagination.dto.js';
const keyHeader = () =>
  ApiHeader({
    name: 'Idempotency-Key',
    required: true,
    description:
      'UUID durable por intención. Repetir exactamente tras respuesta incierta.',
  });

@ApiTags('Provider Execution')
@ApiBearerAuth()
@UseGuards(AccessGuard, RolesGuard, ProviderMembershipGuard)
@Roles('PROVIDER_ADMIN')
@ApiQuery({
  name: 'providerId',
  required: false,
  type: String,
  description:
    'UUID del proveedor; requerido si el operador tiene múltiples memberships.',
})
@Controller('provider/dispatches')
export class ProviderExecutionController {
  constructor(private readonly execution: ExecutionService) {}
  @Get(':dispatchId/execution-attempt')
  @Header('Cache-Control', 'no-store')
  @keyHeader()
  @ApiOkResponse({ type: ProviderAdvanceAttemptResponse })
  @ApiErrors(400, 401, 403, 404, 429, 500)
  @ApiOperation({
    summary: 'Consultar avance histórico propio del administrador',
    description:
      'Consulta exclusivamente el recibo ADVANCE del actor y despacho. No devuelve body ni datos privados. Ausencia permanece incierta. Membership vigente requerido incluso tras transferencia; no restaura permiso de avance.',
  })
  historicalAttempt(
    @Param('dispatchId', new ParseUUIDPipe()) id: string,
    @Req() req: AuthenticatedRequest,
    @CurrentProvider() p: ProviderProfile,
    @Headers('idempotency-key') key: string,
  ) {
    return this.execution.reconcileProviderAdvance(
      id,
      { id: req.user.id, role: 'PROVIDER_ADMIN', providerId: p.id },
      key,
    );
  }
  @Post(':dispatchId/execution-attempt/close')
  @HttpCode(200)
  @keyHeader()
  @ApiOkResponse({ type: ProviderAdvanceAttemptResponse })
  @ApiErrors(400, 401, 403, 404, 409, 429, 500)
  @ApiOperation({
    summary: 'Cerrar intento histórico de avance sin efectos',
    description:
      'Escritura explícita con los locks del comando histórico. Si ya confirmó devuelve APPLIED; de otro modo conserva tombstone CLOSED_NO_EFFECTS. No avanza, no realiza operaciones físicas ni autoriza otro intento del administrador. No habilita despliegue mixto.',
  })
  closeHistoricalAttempt(
    @Param('dispatchId', new ParseUUIDPipe()) id: string,
    @Req() req: AuthenticatedRequest,
    @CurrentProvider() p: ProviderProfile,
    @Headers('idempotency-key') key: string,
  ) {
    return this.execution.reconcileProviderAdvance(
      id,
      { id: req.user.id, role: 'PROVIDER_ADMIN', providerId: p.id },
      key,
      true,
    );
  }
  @Get(':dispatchId/execution')
  @ApiOkResponse({ type: ExecutionDetailResponse })
  @ApiOperation({ summary: 'Progreso e historial del ejecutor vigente' })
  detail(
    @Param('dispatchId', new ParseUUIDPipe()) id: string,
    @Req() req: AuthenticatedRequest,
    @CurrentProvider() p: ProviderProfile,
    @Query() q: ProviderExecutionQueryDto,
  ) {
    return this.execution.detail(
      id,
      {
        id: req.user.id,
        role: 'PROVIDER_ADMIN',
        providerId: p.id,
      },
      q,
    );
  }
  @Post(':dispatchId/execution-events')
  @ExecutionContract('advance')
  @HttpCode(200)
  @keyHeader()
  @ApiOperation({
    summary:
      'Retirado: PROVIDER_ADMIN recibe 403; los hitos pertenecen al Driver asignado',
  })
  advance(
    @Param('dispatchId', new ParseUUIDPipe()) id: string,
    @Req() req: AuthenticatedRequest,
    @CurrentProvider() p: ProviderProfile,
    @Headers('idempotency-key') key: string,
    @Body() body: AdvanceExecutionDto,
  ) {
    return this.execution.advance(
      id,
      { id: req.user.id, role: 'PROVIDER_ADMIN', providerId: p.id },
      key,
      body,
    );
  }
  @Post(':dispatchId/custody-incidents')
  @ExecutionContract('report')
  @keyHeader()
  @ApiOperation({
    summary: 'Reportar incidencia postrecogida y mantener custodia',
  })
  report(
    @Param('dispatchId', new ParseUUIDPipe()) id: string,
    @Req() req: AuthenticatedRequest,
    @CurrentProvider() p: ProviderProfile,
    @Headers('idempotency-key') key: string,
    @Body() body: ReportCustodyIncidentDto,
  ) {
    return this.execution.report(
      id,
      { id: req.user.id, role: 'PROVIDER_ADMIN', providerId: p.id },
      key,
      body,
    );
  }
}
@ApiTags('Driver Execution')
@ApiErrors(400, 401, 403, 404, 429, 500)
@ApiBearerAuth()
@UseGuards(AccessGuard, RolesGuard)
@Roles('DRIVER')
@Controller('driver/dispatches')
export class DriverExecutionController {
  constructor(private readonly execution: ExecutionService) {}
  @Post(':dispatchId/execution-completion')
  @HttpCode(200)
  @keyHeader()
  @ApiOkResponse({ type: DriverCompletionResponse })
  @ApiErrors(400, 401, 403, 404, 409, 429, 500)
  @ApiOperation({
    summary: 'Confirmar entrega propia',
    description:
      'El Driver asignado de flotilla o independiente confirma entrega física. Exige assignmentId, expectedRevision e Idempotency-Key. Legacy utiliza revisión 0. Recibo y delivery.completed se confirman atómicamente; no acredita cobro.',
  })
  complete(
    @Param('dispatchId', new ParseUUIDPipe()) id: string,
    @Req() req: AuthenticatedRequest,
    @Headers('idempotency-key') key: string,
    @Body() body: ExecutionCommandDto,
  ) {
    return this.execution.driverComplete(
      id,
      { id: req.user.id, role: 'DRIVER' },
      key,
      body,
    );
  }
  @Get(':dispatchId/assignments/:assignmentId/attempt')
  @Header('Cache-Control', 'no-store')
  @keyHeader()
  @ApiOkResponse({ type: DriverAttemptResponse })
  @ApiErrors(400, 401, 403, 404, 429, 500)
  @ApiOperation({
    summary: 'Consultar intento técnico propio',
    description:
      'Consulta durable por actor, despacho, asignación, operación y clave. Devuelve APPLIED, CLOSED_NO_EFFECTS o PENDING_OR_UNKNOWN; ausencia no demuestra fracaso. GET no escribe ni reproduce operaciones físicas.',
  })
  attempt(
    @Param('dispatchId', new ParseUUIDPipe()) id: string,
    @Param('assignmentId', new ParseUUIDPipe()) assignmentId: string,
    @Query() q: DriverAttemptParamsDto,
    @Req() req: AuthenticatedRequest,
    @Headers('idempotency-key') key: string,
  ) {
    return this.execution.reconcileDriver(
      id,
      assignmentId,
      q.operation,
      { id: req.user.id, role: 'DRIVER' },
      key,
    );
  }
  @Post(':dispatchId/assignments/:assignmentId/attempt/close')
  @HttpCode(200)
  @keyHeader()
  @ApiOkResponse({ type: DriverAttemptResponse })
  @ApiErrors(400, 401, 403, 404, 409, 429, 500)
  @ApiOperation({
    summary: 'Cerrar explícitamente intento técnico propio',
    description:
      'Serializa con el POST original. Si éste confirmó devuelve APPLIED; de lo contrario persiste CLOSED_NO_EFFECTS y bloquea para siempre esa clave. No cancela ni revierte una entrega física. Sólo el actor original puede cerrar su intento.',
  })
  close(
    @Param('dispatchId', new ParseUUIDPipe()) id: string,
    @Param('assignmentId', new ParseUUIDPipe()) assignmentId: string,
    @Query() q: DriverAttemptParamsDto,
    @Req() req: AuthenticatedRequest,
    @Headers('idempotency-key') key: string,
  ) {
    return this.execution.reconcileDriver(
      id,
      assignmentId,
      q.operation,
      { id: req.user.id, role: 'DRIVER' },
      key,
      true,
    );
  }
  @Get(':dispatchId/execution')
  @ApiOkResponse({ type: ExecutionDetailResponse })
  @ApiOperation({
    summary: 'Consultar progreso propio de flotilla o independiente',
    description:
      'Consulta la asignación vigente del Driver autenticado, su progreso e historial paginado. No concede acceso a servicios ajenos ni permisos de TAKE al Driver de flotilla. Los servicios anteriores permanecen LEGACY_UNTRACKED.',
  })
  detail(
    @Param('dispatchId', new ParseUUIDPipe()) id: string,
    @Req() req: AuthenticatedRequest,
    @Query() q: PaginationQueryDto,
  ) {
    return this.execution.detail(id, { id: req.user.id, role: 'DRIVER' }, q);
  }
  @Post(':dispatchId/execution-events')
  @ExecutionContract('advance')
  @HttpCode(200)
  @keyHeader()
  @ApiOperation({
    summary: 'Registrar siguiente hito del Driver asignado',
    description:
      'Registra exclusivamente el siguiente hito consecutivo de la asignación vigente. Valida Driver, custodia y revisión esperada. La clave durable permite replay sin duplicar historial; una clave cerrada devuelve EXECUTION_ATTEMPT_CLOSED.',
  })
  advance(
    @Param('dispatchId', new ParseUUIDPipe()) id: string,
    @Req() req: AuthenticatedRequest,
    @Headers('idempotency-key') key: string,
    @Body() body: AdvanceExecutionDto,
  ) {
    return this.execution.advance(
      id,
      { id: req.user.id, role: 'DRIVER' },
      key,
      body,
    );
  }
  @Post(':dispatchId/custody-incidents')
  @ExecutionContract('report')
  @keyHeader()
  @ApiOperation({
    summary: 'Reportar incidencia del Driver asignado bajo custodia',
    description:
      'El Driver vigente informa imposibilidad de entrega después de recoger. Conserva custodia y recursos y bloquea avances hasta resolución excepcional. El recibo durable permite recuperar respuestas inciertas sin duplicar incidencias.',
  })
  report(
    @Param('dispatchId', new ParseUUIDPipe()) id: string,
    @Req() req: AuthenticatedRequest,
    @Headers('idempotency-key') key: string,
    @Body() body: ReportCustodyIncidentDto,
  ) {
    return this.execution.report(
      id,
      { id: req.user.id, role: 'DRIVER' },
      key,
      body,
    );
  }
}
@ApiTags('Admin Custody')
@ApiBearerAuth()
@UseGuards(AccessGuard, RolesGuard)
@Roles('SUPER_ADMIN')
@Controller('admin')
export class AdminExecutionController {
  @Get(
    'dispatches/:dispatchId/custody-incidents/:incidentId/resolution-attempt',
  )
  @Header('Cache-Control', 'no-store')
  @HttpCode(200)
  @keyHeader()
  @ApiOkResponse({ type: ResolutionAttemptResponse })
  @ApiOperation({
    summary:
      'Consultar recibo propio; ausencia permanece incierta y GET no cierra el intento',
  })
  attempt(
    @Param('dispatchId', new ParseUUIDPipe()) id: string,
    @Param('incidentId', new ParseUUIDPipe()) incident: string,
    @Req() req: AuthenticatedRequest,
    @Headers('idempotency-key') key: string,
  ) {
    return this.execution.reconcileResolution(
      id,
      incident,
      { id: req.user.id, role: 'SUPER_ADMIN' },
      key,
    );
  }
  @Post(
    'dispatches/:dispatchId/custody-incidents/:incidentId/resolution-attempt/close',
  )
  @HttpCode(200)
  @keyHeader()
  @ApiOkResponse({ type: ResolutionAttemptResponse })
  @ApiOperation({
    summary:
      'Cerrar clave propia sin efectos bajo los mismos locks que resolve; devuelve APPLIED si ya confirmó. No resuelve ni realiza operaciones físicas',
  })
  closeAttempt(
    @Param('dispatchId', new ParseUUIDPipe()) id: string,
    @Param('incidentId', new ParseUUIDPipe()) incident: string,
    @Req() req: AuthenticatedRequest,
    @Headers('idempotency-key') key: string,
  ) {
    return this.execution.reconcileResolution(
      id,
      incident,
      { id: req.user.id, role: 'SUPER_ADMIN' },
      key,
      true,
    );
  }
  constructor(
    private readonly execution: ExecutionService,
    private readonly db: PrismaService,
  ) {}
  @Get('custody-incidents')
  @ApiOkResponse({ type: IncidentPageResponse })
  @ApiOperation({
    summary:
      'Cola persistente de incidencias abiertas; sin envío automático de correo',
  })
  async list(@Query() q: IncidentQueryDto) {
    return this.db.$transaction(
      async (tx) => {
        const where = {
          resolvedAt: q.status === 'OPEN' ? null : { not: null },
        };
        const items = await tx.deliveryCustodyIncident.findMany({
          where,
          select: {
            id: true,
            dispatchId: true,
            reportedAt: true,
            reasonCode: true,
            resolvedAt: true,
          },
          orderBy: [{ reportedAt: 'asc' }, { id: 'asc' }],
          take: q.pageSize,
          skip: (q.page - 1) * q.pageSize,
        });
        return pageResult(
          items,
          await tx.deliveryCustodyIncident.count({ where }),
          q,
        );
      },
      { isolationLevel: 'RepeatableRead' },
    );
  }
  @Get('dispatches/:dispatchId/custody-incidents/:incidentId')
  @ApiOkResponse({ type: IncidentDetailResponse })
  @ApiOperation({
    summary: 'Auditoría privada de incidencia y resolución; sólo SUPER_ADMIN',
  })
  incident(
    @Param('dispatchId', new ParseUUIDPipe()) id: string,
    @Param('incidentId', new ParseUUIDPipe()) incident: string,
  ) {
    return this.execution.incidentDetail(id, incident);
  }
  @Get('dispatches/:dispatchId/custody-transfer-candidates')
  @ApiOkResponse({ type: TransferCandidatePageResponse })
  @ApiOperation({
    summary:
      'Pares elegibles de conductor y vehículo; disponibilidad revalidada al resolver',
  })
  candidates(
    @Param('dispatchId', new ParseUUIDPipe()) id: string,
    @Query() q: TransferCandidatesQueryDto,
  ) {
    return this.execution.transferCandidates(id, q);
  }
  @Get('dispatches/:dispatchId/execution')
  @ApiOkResponse({ type: ExecutionDetailResponse })
  @ApiOperation({ summary: 'Auditar progreso sin suplantar al ejecutor' })
  detail(
    @Param('dispatchId', new ParseUUIDPipe()) id: string,
    @Req() req: AuthenticatedRequest,
    @Query() q: PaginationQueryDto,
  ) {
    return this.execution.detail(
      id,
      { id: req.user.id, role: 'SUPER_ADMIN' },
      q,
    );
  }
  @Post('dispatches/:dispatchId/custody-incidents')
  @ExecutionContract('report')
  @keyHeader()
  @ApiOperation({ summary: 'Registrar escalamiento recibido de custodia' })
  report(
    @Param('dispatchId', new ParseUUIDPipe()) id: string,
    @Req() req: AuthenticatedRequest,
    @Headers('idempotency-key') key: string,
    @Body() body: ReportCustodyIncidentDto,
  ) {
    return this.execution.report(
      id,
      { id: req.user.id, role: 'SUPER_ADMIN' },
      key,
      body,
    );
  }
  @Post('dispatches/:dispatchId/custody-incidents/:incidentId/resolve')
  @ExecutionContract('resolve')
  @HttpCode(200)
  @keyHeader()
  @ApiOperation({
    summary:
      'Resolver por devolución confirmada o transferencia; sin cargo/refund automático',
  })
  resolve(
    @Param('dispatchId', new ParseUUIDPipe()) id: string,
    @Param('incidentId', new ParseUUIDPipe()) incident: string,
    @Req() req: AuthenticatedRequest,
    @Headers('idempotency-key') key: string,
    @Body() body: ResolveCustodyIncidentDto,
  ) {
    return this.execution.resolve(
      id,
      incident,
      { id: req.user.id, role: 'SUPER_ADMIN' },
      key,
      body,
    );
  }
}
