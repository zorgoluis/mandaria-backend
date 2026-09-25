import {
  Controller,
  Get,
  Param,
  ParseUUIDPipe,
  UseGuards,
} from '@nestjs/common';
import {
  ApiBearerAuth,
  ApiOkResponse,
  ApiOperation,
  ApiParam,
  ApiTags,
} from '@nestjs/swagger';
import { AccessGuard, Roles, RolesGuard } from '../auth/auth.guards.js';
import { ApiErrors } from '../common/api-errors.decorator.js';
import { DeliveryAssignmentsService } from './delivery-assignments.service.js';
import { AdminDeliveryAssignmentResponse } from './delivery-assignments.responses.js';

@ApiTags('Admin Dispatch')
@ApiBearerAuth()
@UseGuards(AccessGuard, RolesGuard)
@Roles('SUPER_ADMIN')
@Controller('admin/dispatches')
export class AdminAssignmentsController {
  constructor(private readonly assignments: DeliveryAssignmentsService) {}

  @Get(':dispatchId/assignments')
  @ApiParam({ name: 'dispatchId', format: 'uuid' })
  @ApiOkResponse({ type: AdminDeliveryAssignmentResponse, isArray: true })
  @ApiErrors(400, 401, 403, 404, 429, 500)
  @ApiOperation({
    summary: 'Historial de asignaciones de un Dispatch',
    description:
      'Sólo SUPER_ADMIN (lectura y auditoría). Todas las asignaciones del Dispatch con su proveedor, Driver, Vehicle, quién asignó y terminó, motivo y fechas. SUPER_ADMIN no asigna ni reasigna recursos: eso corresponde al proveedor dueño del claim.',
  })
  history(@Param('dispatchId', new ParseUUIDPipe()) dispatchId: string) {
    return this.assignments.historyForAdmin(dispatchId);
  }
}
