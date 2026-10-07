import {
  Controller,
  Get,
  Post,
  Req,
  Query,
  Headers,
  UseGuards,
  HttpCode,
  Param,
  ParseUUIDPipe,
} from '@nestjs/common';
import {
  ApiBearerAuth,
  ApiHeader,
  ApiOperation,
  ApiResponse,
  ApiTags,
} from '@nestjs/swagger';
import {
  AccessGuard,
  RolesGuard,
  Roles,
  type AuthenticatedRequest,
} from '../auth/auth.guards.js';
import { CustomersService } from './customers.service.js';
import { CommandAttemptsService } from './command-attempts.service.js';
import {
  CustomerAttemptQuery,
  HumanAttemptResult,
  ConsentContext,
} from './command-attempts.dto.js';
@ApiTags('Customer command recovery')
@ApiBearerAuth()
@UseGuards(AccessGuard)
@ApiResponse({
  status: 403,
  description: 'Perfil humano propio activo y verificado requerido.',
})
@ApiResponse({ status: 404, description: 'Recurso inexistente o ajeno.' })
@ApiResponse({
  status: 409,
  description:
    'COMMAND_ATTEMPT_SCOPE_CONFLICT: clave usada con otra operación o recurso; no borrar el marcador.',
})
@Controller('customer')
export class CustomerCommandAttemptsController {
  constructor(
    private readonly customers: CustomersService,
    private readonly attempts: CommandAttemptsService,
  ) {}
  @Get('command-attempt')
  @ApiHeader({ name: 'Idempotency-Key', required: true })
  @ApiResponse({ status: 200, type: HumanAttemptResult })
  @ApiOperation({
    summary:
      'Consultar intento propio sin cuerpo original; GET no cierra ni ejecuta comandos',
  })
  async get(
    @Req() req: AuthenticatedRequest,
    @Headers('idempotency-key') key: string,
    @Query() q: CustomerAttemptQuery,
  ) {
    return this.attempts.customer(
      (await this.customers.account(req.user.id)).id,
      req.user.id,
      key,
      q,
    );
  }
  @Post('command-attempt/close')
  @HttpCode(200)
  @ApiHeader({ name: 'Idempotency-Key', required: true })
  @ApiResponse({ status: 200, type: HumanAttemptResult })
  @ApiOperation({
    summary:
      'Cerrar explícitamente el intento; impide commit tardío, conserva routing/presupuesto ya autorizado',
  })
  async close(
    @Req() req: AuthenticatedRequest,
    @Headers('idempotency-key') key: string,
    @Query() q: CustomerAttemptQuery,
  ) {
    return this.attempts.customer(
      (await this.customers.account(req.user.id)).id,
      req.user.id,
      key,
      q,
      true,
    );
  }
  @Get('delivery-requests/:publicId/consent-context')
  @ApiOperation({
    summary:
      'Recuperar MPQ/MQ y hash final propios entre dispositivos; no renueva vigencia ni fabrica consentimiento',
  })
  @ApiResponse({ status: 200, type: ConsentContext })
  async context(
    @Req() req: AuthenticatedRequest,
    @Param('publicId') id: string,
  ) {
    return this.attempts.consentContext(
      (await this.customers.account(req.user.id)).id,
      id,
    );
  }
}
@ApiTags('Admin shipping policy recovery')
@ApiBearerAuth()
@UseGuards(AccessGuard, RolesGuard)
@Roles('SUPER_ADMIN')
@ApiHeader({ name: 'Idempotency-Key', required: true })
@ApiResponse({ status: 200, type: HumanAttemptResult })
@ApiResponse({
  status: 403,
  description:
    'SUPER_ADMIN humano requerido. Sólo sus propios intentos; otro administrador usa su propia identidad y clave.',
})
@ApiResponse({ status: 409, description: 'COMMAND_ATTEMPT_SCOPE_CONFLICT.' })
@Controller('admin/integrations/:id/shipping-policy/attempt')
export class ShippingPolicyAttemptController {
  constructor(private readonly attempts: CommandAttemptsService) {}
  @Get()
  @ApiOperation({
    summary:
      'Acreditar recibo original de política por actor/clave; no comparar sólo política actual',
  })
  get(
    @Req() req: AuthenticatedRequest,
    @Param('id', new ParseUUIDPipe()) id: string,
    @Headers('idempotency-key') key: string,
  ) {
    return this.attempts.policy(id, req.user.id, key);
  }
  @Post('close')
  @HttpCode(200)
  @ApiOperation({
    summary:
      'Cerrar intención de política propia de forma atómica con el POST original',
  })
  close(
    @Req() req: AuthenticatedRequest,
    @Param('id', new ParseUUIDPipe()) id: string,
    @Headers('idempotency-key') key: string,
  ) {
    return this.attempts.policy(id, req.user.id, key, true);
  }
}
