import {
  Body,
  Controller,
  Get,
  HttpCode,
  Param,
  Post,
  Query,
  Req,
  Res,
  UseGuards,
} from '@nestjs/common';
import {
  ApiBearerAuth,
  ApiOkResponse,
  ApiOperation,
  ApiParam,
  ApiTags,
} from '@nestjs/swagger';
import type { Response } from 'express';
import { AccessGuard, Roles, RolesGuard } from '../auth/auth.guards.js';
import type { AuthenticatedRequest } from '../auth/auth.guards.js';
import { ApiErrorDescriptions } from '../common/api-errors.decorator.js';
import {
  ChangePartnerApplicationStatusDto,
  LinkPartnerApplicationDto,
  PartnerApplicationListQueryDto,
} from './partner-applications.dto.js';
import {
  PartnerApplicationPageResponse,
  PartnerApplicationResponse,
} from './partner-applications.responses.js';
import { PartnerApplicationsService } from './partner-applications.service.js';

const referenceParam = ApiParam({
  name: 'reference',
  example: 'SOC-000123',
  description: 'Referencia pública SOC-NNNNNN (no distingue mayúsculas).',
});
const base = {
  400: 'VALIDATION_ERROR: filtros o campos inválidos; campos desconocidos rechazados.',
  401: 'Se requiere access JWT humano de un User ACTIVE; un token B2B no es válido.',
  403: 'Rol global distinto de SUPER_ADMIN.',
  429: 'Límite de peticiones por IP excedido (100/minuto).',
  500: 'Error interno sanitizado.',
};
const notFound = {
  404: 'PARTNER_APPLICATION_NOT_FOUND: referencia inexistente o con formato inválido.',
};

@ApiTags('Admin Partner Applications')
@ApiBearerAuth()
@UseGuards(AccessGuard, RolesGuard)
@Roles('SUPER_ADMIN')
@Controller('admin/partner-applications')
export class AdminPartnerApplicationsController {
  constructor(private readonly applications: PartnerApplicationsService) {}

  @Get()
  @ApiOkResponse({ type: PartnerApplicationPageResponse })
  @ApiErrorDescriptions(base)
  @ApiOperation({
    summary: 'Listar solicitudes de socio',
    description:
      'Paginación page/pageSize existente, de la más reciente a la más antigua. Filtros status, type y q (referencia, nombre, teléfono, correo, flotilla).',
  })
  list(@Query() query: PartnerApplicationListQueryDto) {
    return this.applications.list(query);
  }

  @Get(':reference')
  @referenceParam
  @ApiOkResponse({ type: PartnerApplicationResponse })
  @ApiErrorDescriptions({ ...base, ...notFound })
  @ApiOperation({ summary: 'Detalle de una solicitud de socio' })
  get(@Param('reference') reference: string) {
    return this.applications.get(reference);
  }

  @Post(':reference/status')
  @HttpCode(200)
  @referenceParam
  @ApiOkResponse({ type: PartnerApplicationResponse })
  @ApiErrorDescriptions({
    ...base,
    ...notFound,
    409: 'PARTNER_APPLICATION_INVALID_TRANSITION: transición no permitida, APPROVED sin nota ni vínculo, o APPROVED→REJECTED sin nota nueva.',
  })
  @ApiOperation({
    summary: 'Cambiar el estado de una solicitud de socio',
    description:
      'RECEIVED→CONTACTED/REJECTED/DISCARDED; CONTACTED→APPROVED/REJECTED/DISCARDED; APPROVED→REJECTED. REJECTED y DISCARDED son terminales. Registra statusChangedAt y el SUPER_ADMIN que actuó. No crea cuentas, proveedores ni invitaciones.',
  })
  changeStatus(
    @Param('reference') reference: string,
    @Body() dto: ChangePartnerApplicationStatusDto,
    @Req() req: AuthenticatedRequest,
    @Res({ passthrough: true }) res: Response,
  ) {
    return this.applications.changeStatus(
      reference,
      dto,
      req.user.id,
      res.locals.requestId as string,
    );
  }

  @Post(':reference/links')
  @HttpCode(200)
  @referenceParam
  @ApiOkResponse({ type: PartnerApplicationResponse })
  @ApiErrorDescriptions({
    ...base,
    ...notFound,
    409: 'PARTNER_APPLICATION_LINK_INVALID: la solicitud no está APPROVED; proveedor inexistente, no FLEET o en solicitud INDIVIDUAL; invitación inexistente, con otro email o de otro proveedor.',
  })
  @ApiOperation({
    summary: 'Registrar vínculos de una solicitud aprobada',
    description:
      'Registra el proveedor (sólo FLEET) y/o la invitación creados con los flujos existentes. Al menos uno es obligatorio; un valor nuevo reemplaza al anterior. No crea ni modifica proveedores o invitaciones.',
  })
  link(
    @Param('reference') reference: string,
    @Body() dto: LinkPartnerApplicationDto,
    @Req() req: AuthenticatedRequest,
    @Res({ passthrough: true }) res: Response,
  ) {
    return this.applications.link(
      reference,
      dto,
      req.user.id,
      res.locals.requestId as string,
    );
  }
}
