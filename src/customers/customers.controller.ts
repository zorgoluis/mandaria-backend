import {
  Body,
  Controller,
  Get,
  HttpCode,
  Patch,
  Post,
  Req,
  UseGuards,
} from '@nestjs/common';
import {
  ApiBearerAuth,
  ApiOperation,
  ApiTags,
  ApiResponse,
} from '@nestjs/swagger';
import { Throttle } from '@nestjs/throttler';
import { AccessGuard } from '../auth/auth.guards.js';
import type { AuthenticatedRequest } from '../auth/auth.guards.js';
import { CustomersService } from './customers.service.js';
import {
  CustomerConfirmDto,
  CustomerEmailDto,
  CustomerProfileDto,
  CustomerTokenDto,
  RegisterCustomerDto,
  UpdateCustomerDto,
  CustomerAcceptedDto,
  CustomerConfirmedDto,
  CustomerProfileViewDto,
  ChangeCustomerTypeDto,
} from './customers.dto.js';
@ApiTags('Customer registration and recovery')
@ApiResponse({
  status: 400,
  description:
    'Validación o ACCESS_TOKEN_INVALID; no revela identidad por correo.',
})
@ApiResponse({ status: 410, description: 'ACCESS_TOKEN_EXPIRED' })
@ApiResponse({
  status: 429,
  description: 'Límite por IP/operación: cinco solicitudes por minuto.',
})
@ApiResponse({
  status: 503,
  description:
    'CUSTOMER_ADMISSION_DISABLED para alta/confirmación; recuperación de cuentas existentes permanece disponible.',
})
@Throttle({ default: { limit: 5, ttl: 60000 } })
@Controller()
export class CustomerRegistrationController {
  constructor(private readonly customers: CustomersService) {}
  @Post('customer-registration')
  @HttpCode(202)
  @ApiResponse({
    status: 202,
    type: CustomerAcceptedDto,
    description:
      'Respuesta genérica. El correo contiene el token de uso único; no se devuelve por API.',
  })
  @ApiOperation({
    summary:
      'Solicitar registro cliente; respuesta genérica, admisión deshabilitada por defecto',
  })
  register(@Body() dto: RegisterCustomerDto) {
    return this.customers.register(dto);
  }
  @Post('customer-registration/resend')
  @HttpCode(202)
  @ApiOperation({
    summary:
      'Repetir solicitud de registro con perfil completo; invalida el token anterior aún pendiente',
  })
  @ApiResponse({ status: 202, type: CustomerAcceptedDto })
  resend(@Body() dto: RegisterCustomerDto) {
    return this.customers.register(dto);
  }
  @Post('customer-registration/confirm')
  @HttpCode(201)
  @ApiOperation({
    summary:
      'Verificar correo y crear usuario CUSTOMER con perfil; no concede permisos operativos',
  })
  @ApiResponse({ status: 201, type: CustomerConfirmedDto })
  confirm(@Body() dto: CustomerConfirmDto) {
    return this.customers.confirm(dto.token, dto.password, 'REGISTER');
  }
  @Post('auth/password-recovery')
  @HttpCode(202)
  @ApiOperation({
    summary:
      'Solicitar recuperación de una cuenta humana existente; respuesta genérica',
  })
  @ApiResponse({ status: 202, type: CustomerAcceptedDto })
  recover(@Body() dto: CustomerEmailDto) {
    return this.customers.challenge(dto.email, 'RESET');
  }
  @Post('auth/password-reset')
  @HttpCode(200)
  @ApiOperation({
    summary:
      'Restablecer contraseña; invalida todas las sesiones anteriores de esa cuenta',
  })
  @ApiResponse({ status: 200, type: CustomerConfirmedDto })
  reset(@Body() dto: CustomerConfirmDto) {
    return this.customers.confirm(dto.token, dto.password, 'RESET');
  }
}
@ApiTags('Customer profile')
@ApiBearerAuth()
@UseGuards(AccessGuard)
@ApiResponse({
  status: 401,
  description:
    'JWT humano inválido, cuenta inactiva o sesión anterior a recuperación de contraseña.',
})
@ApiResponse({
  status: 403,
  description: 'CUSTOMER_CONTACT_NOT_VERIFIED o CUSTOMER_ACCESS_DENIED.',
})
@ApiResponse({
  status: 409,
  description: 'PROFILE_ALREADY_EXISTS o PROFILE_REVISION_CONFLICT.',
})
@Controller('customer')
export class CustomerProfileController {
  constructor(private readonly customers: CustomersService) {}
  @Get('capabilities')
  @ApiOperation({
    summary:
      'Consultar cupo durable y pagadores permitidos; GET no libera cupo ni confirma disponibilidad logística',
  })
  @ApiResponse({
    status: 200,
    schema: {
      type: 'object',
      required: [
        'type',
        'allowedShippingPayers',
        'defaultShippingPayer',
        'capacity',
        'canCreateRequest',
        'canPrequote',
        'reason',
      ],
      properties: {
        type: { type: 'string', enum: ['PERSONAL', 'BUSINESS'] },
        allowedShippingPayers: {
          type: 'array',
          items: { type: 'string', enum: ['REQUESTER', 'RECIPIENT'] },
        },
        defaultShippingPayer: { type: 'string', enum: ['REQUESTER'] },
        capacity: {
          type: 'object',
          properties: {
            maxActiveRequests: { type: 'integer', nullable: true },
            occupied: { type: 'boolean' },
            activeCount: { type: 'integer' },
            activeRequestPublicId: { type: 'string', nullable: true },
          },
        },
        canCreateRequest: { type: 'boolean' },
        canPrequote: { type: 'boolean' },
        reason: { type: 'string', nullable: true },
      },
    },
  })
  capabilities(@Req() req: AuthenticatedRequest) {
    return this.customers.capabilities(req.user.id);
  }
  @Post('profile/type')
  @HttpCode(200)
  @ApiOperation({
    summary:
      'Cambiar tipo propio sólo sin solicitudes abiertas; expectedRevision detecta concurrencia y respuesta incierta se reconcilia con GET profile',
  })
  @ApiResponse({ status: 200, type: CustomerProfileViewDto })
  @ApiResponse({
    status: 409,
    description:
      'CUSTOMER_ACTIVE_REQUESTS o PROFILE_REVISION_CONFLICT; no cambia contratos existentes.',
  })
  changeType(
    @Req() req: AuthenticatedRequest,
    @Body() dto: ChangeCustomerTypeDto,
  ) {
    return this.customers.changeType(req.user.id, dto);
  }
  @Post('contact-verification')
  @HttpCode(202)
  @Throttle({ default: { limit: 5, ttl: 60000 } })
  @ApiOperation({
    summary:
      'Enviar verificación al correo de la cuenta autenticada; no permite elegir otra dirección',
  })
  @ApiResponse({ status: 202, type: CustomerAcceptedDto })
  verify(@Req() req: AuthenticatedRequest) {
    return this.customers.verifyContact(req.user.id);
  }
  @Post('contact-verification/confirm')
  @HttpCode(200)
  @Throttle({ default: { limit: 5, ttl: 60000 } })
  @ApiOperation({ summary: 'Confirmar el correo propio; token ajeno inválido' })
  @ApiResponse({ status: 200, type: CustomerConfirmedDto })
  verified(@Req() req: AuthenticatedRequest, @Body() dto: CustomerTokenDto) {
    return this.customers.verifyContact(req.user.id, dto.token);
  }
  @Post('profile')
  @ApiOperation({
    summary:
      'Crear perfil propio verificado, conservando rol operativo y sesiones',
  })
  @ApiResponse({ status: 201, type: CustomerProfileViewDto })
  attach(@Req() req: AuthenticatedRequest, @Body() dto: CustomerProfileDto) {
    return this.customers.attach(req.user.id, dto);
  }
  @Get('profile')
  @ApiOperation({
    summary: 'Consultar perfil propio activo; un JWT B2B no es válido',
  })
  @ApiResponse({ status: 200, type: CustomerProfileViewDto })
  profile(@Req() req: AuthenticatedRequest) {
    return this.customers.profile(req.user.id);
  }
  @Patch('profile')
  @ApiOperation({
    summary:
      'Actualizar nombres con expectedRevision; no cambia tipo, usuario ni permisos',
  })
  @ApiResponse({ status: 200, type: CustomerProfileViewDto })
  update(@Req() req: AuthenticatedRequest, @Body() dto: UpdateCustomerDto) {
    return this.customers.update(req.user.id, dto);
  }
}
