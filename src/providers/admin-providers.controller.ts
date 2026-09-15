import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  Param,
  ParseUUIDPipe,
  Patch,
  Post,
  Query,
  Req,
  UseGuards,
} from '@nestjs/common';
import {
  ApiBearerAuth,
  ApiCreatedResponse,
  ApiNoContentResponse,
  ApiOkResponse,
  ApiOperation,
  ApiParam,
  ApiTags,
} from '@nestjs/swagger';
import { AccessGuard, Roles, RolesGuard } from '../auth/auth.guards.js';
import type { AuthenticatedRequest } from '../auth/auth.guards.js';
import { ApiErrors } from '../common/api-errors.decorator.js';
import { PaginationQueryDto } from '../common/pagination.dto.js';
import { ProvidersService } from './providers.service.js';
import { ProviderMembersService } from './provider-members.service.js';
import {
  AddProviderMemberDto,
  CreateProviderDto,
  EmptyProviderActionDto,
  ProviderListQueryDto,
  UpdateProviderDto,
} from './providers.dto.js';
import {
  ProviderMemberPageResponse,
  ProviderMemberResponse,
  ProviderPageResponse,
  ProviderResponse,
} from './providers.responses.js';

@ApiTags('Admin Providers')
@ApiBearerAuth()
@ApiErrors(400, 401, 403, 429, 500)
@UseGuards(AccessGuard, RolesGuard)
@Roles('SUPER_ADMIN')
@Controller('admin/providers')
export class AdminProvidersController {
  constructor(
    private readonly providers: ProvidersService,
    private readonly members: ProviderMembersService,
  ) {}
  @Post()
  @ApiCreatedResponse({ type: ProviderResponse })
  @ApiErrors(409)
  @ApiOperation({
    summary: 'Crear proveedor FLEET o INDEPENDENT',
    description:
      'Sólo SUPER_ADMIN. Crea en PENDING. Código único normalizado a mayúsculas. Cada límite omitido se obtiene del entorno según type (FLEET 10/10 e INDEPENDENT 1/2 por defecto). No crea User, Driver, Vehicle ni IntegrationClient.',
  })
  create(@Body() dto: CreateProviderDto, @Req() req: AuthenticatedRequest) {
    return this.providers.create(dto, req.user.id);
  }
  @Get()
  @ApiOkResponse({ type: ProviderPageResponse })
  @ApiOperation({
    summary: 'Listar proveedores con filtros y paginación',
    description:
      'Sólo SUPER_ADMIN. Combina type, status y search (nombre/código, sin distinguir mayúsculas). page=1, pageSize=20; máximo 100. Orden estable createdAt DESC, id DESC. items y total se leen en el mismo snapshot. Una página vacía devuelve 200.',
  })
  list(@Query() query: ProviderListQueryDto) {
    return this.providers.list(query);
  }
  @Get(':id')
  @ApiOkResponse({ type: ProviderResponse })
  @ApiErrors(404)
  @ApiParam({ name: 'id', format: 'uuid', description: 'DeliveryProvider.id' })
  @ApiOperation({
    summary: 'Consultar proveedor por ID',
    description:
      'Sólo SUPER_ADMIN, para cualquier proveedor y estado. Devuelve límites y timestamps; no usuarios, secretos ni datos de integraciones.',
  })
  get(@Param('id', new ParseUUIDPipe()) id: string) {
    return this.providers.get(id);
  }
  @Patch(':id')
  @ApiOkResponse({ type: ProviderResponse })
  @ApiErrors(404, 409)
  @ApiParam({ name: 'id', format: 'uuid', description: 'DeliveryProvider.id' })
  @ApiOperation({
    summary: 'Editar datos y límites administrativos',
    description:
      'Sólo SUPER_ADMIN. Requiere al menos name, code, maxDrivers o maxVehicles. Campos omitidos se conservan. Límites enteros de 1 a 10000; aún no se cuentan repartidores/vehículos. type y status NO son editables aquí; los estados tienen acciones explícitas y la conversión de tipo queda para otra versión.',
  })
  update(
    @Param('id', new ParseUUIDPipe()) id: string,
    @Body() dto: UpdateProviderDto,
    @Req() req: AuthenticatedRequest,
  ) {
    return this.providers.update(id, dto, req.user.id);
  }
  @Post(':id/activate')
  @HttpCode(200)
  @ApiOkResponse({ type: ProviderResponse })
  @ApiErrors(404, 409)
  @ApiParam({ name: 'id', format: 'uuid', description: 'DeliveryProvider.id' })
  @ApiOperation({
    summary: 'Activar o reactivar proveedor',
    description:
      'Sólo SUPER_ADMIN. PENDING → ACTIVE o SUSPENDED → ACTIVE. Si ya está ACTIVE, devuelve 200 sin otro cambio. Body vacío; no crea recursos logísticos.',
  })
  activate(
    @Param('id', new ParseUUIDPipe()) id: string,
    @Body() _dto: EmptyProviderActionDto,
    @Req() req: AuthenticatedRequest,
  ) {
    return this.providers.transition(id, 'ACTIVE', req.user.id);
  }
  @Post(':id/suspend')
  @HttpCode(200)
  @ApiOkResponse({ type: ProviderResponse })
  @ApiErrors(404, 409)
  @ApiParam({ name: 'id', format: 'uuid', description: 'DeliveryProvider.id' })
  @ApiOperation({
    summary: 'Suspender proveedor activo',
    description:
      'Sólo SUPER_ADMIN. ACTIVE → SUSPENDED. Repetir en SUSPENDED devuelve 200; PENDING → SUSPENDED devuelve 409. No elimina al proveedor, memberships ni usuarios. Sus administradores conservan consulta del perfil para conocer el estado.',
  })
  suspend(
    @Param('id', new ParseUUIDPipe()) id: string,
    @Body() _dto: EmptyProviderActionDto,
    @Req() req: AuthenticatedRequest,
  ) {
    return this.providers.transition(id, 'SUSPENDED', req.user.id);
  }
  @Post(':providerId/members')
  @ApiCreatedResponse({ type: ProviderMemberResponse })
  @ApiErrors(404, 409)
  @ApiParam({
    name: 'providerId',
    format: 'uuid',
    description: 'Proveedor al que se asignará el User existente.',
  })
  @ApiOperation({
    summary: 'Asociar administrador existente',
    description:
      'Sólo SUPER_ADMIN. User debe existir, estar activo y tener rol global PROVIDER_ADMIN. Membership OWNER/ADMIN es local al proveedor; no cambia User.role. Permite varios administradores por proveedor y varios proveedores por usuario. Duplicar el par providerId/userId devuelve 409.',
  })
  addMember(
    @Param('providerId', new ParseUUIDPipe()) providerId: string,
    @Body() dto: AddProviderMemberDto,
    @Req() req: AuthenticatedRequest,
  ) {
    return this.members.add(providerId, dto, req.user.id);
  }
  @Get(':providerId/members')
  @ApiOkResponse({ type: ProviderMemberPageResponse })
  @ApiErrors(404)
  @ApiParam({
    name: 'providerId',
    format: 'uuid',
    description: 'DeliveryProvider.id',
  })
  @ApiOperation({
    summary: 'Listar memberships administrativas',
    description:
      'Sólo SUPER_ADMIN. Paginación page/pageSize. Incluye User.id, email, rol global y active para identificar administradores. Nunca incluye passwordHash, tokens ni credenciales. Memberships no representan Drivers.',
  })
  listMembers(
    @Param('providerId', new ParseUUIDPipe()) providerId: string,
    @Query() query: PaginationQueryDto,
  ) {
    return this.members.list(providerId, query);
  }
  @Delete(':providerId/members/:membershipId')
  @HttpCode(204)
  @ApiNoContentResponse({
    description: 'Relación retirada. User y proveedor permanecen.',
  })
  @ApiErrors(404)
  @ApiParam({
    name: 'providerId',
    format: 'uuid',
    description: 'Proveedor dueño de la membership.',
  })
  @ApiParam({
    name: 'membershipId',
    format: 'uuid',
    description: 'ProviderMembership.id, no User.id.',
  })
  @ApiOperation({
    summary: 'Retirar administrador de este proveedor',
    description:
      'Sólo SUPER_ADMIN. Elimina únicamente la relación exacta providerId/membershipId. No borra ni desactiva User. El siguiente acceso al perfil con un JWT anterior será rechazado. No exige mantener un OWNER: SUPER_ADMIN puede gestionar proveedores sin miembros.',
  })
  removeMember(
    @Param('providerId', new ParseUUIDPipe()) providerId: string,
    @Param('membershipId', new ParseUUIDPipe()) membershipId: string,
    @Req() req: AuthenticatedRequest,
  ) {
    return this.members.remove(providerId, membershipId, req.user.id);
  }
}
