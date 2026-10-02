import { ApiOkResponse, ApiQuery } from '@nestjs/swagger';
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
      'Registrar siguiente hito reportado por teléfono; no acredita cobro',
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
@ApiTags('Independent Execution')
@ApiBearerAuth()
@UseGuards(AccessGuard, RolesGuard)
@Roles('DRIVER')
@Controller('driver/dispatches')
export class DriverExecutionController {
  constructor(private readonly execution: ExecutionService) {}
  @Get(':dispatchId/execution')
  @ApiOkResponse({ type: ExecutionDetailResponse })
  @ApiOperation({ summary: 'Consultar progreso independiente propio' })
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
  @ApiOperation({ summary: 'Registrar siguiente hito del independiente' })
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
    summary: 'Reportar incidencia del independiente bajo custodia',
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
