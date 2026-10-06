import {
  Body,
  Controller,
  Get,
  Headers,
  HttpCode,
  Param,
  ParseUUIDPipe,
  Post,
  Req,
  UseGuards,
  BadRequestException,
  NotFoundException,
} from '@nestjs/common';
import {
  ApiBearerAuth,
  ApiHeader,
  ApiOperation,
  ApiProperty,
  ApiTags,
  ApiResponse,
} from '@nestjs/swagger';
import { IsIn, IsInt, Min, isUUID } from 'class-validator';
import {
  AccessGuard,
  Roles,
  RolesGuard,
  type AuthenticatedRequest,
} from '../auth/auth.guards.js';
import { PrismaService } from '../prisma/prisma.service.js';
import { fingerprint } from '../idempotency/idempotency.service.js';
import { DomainException } from '../common/domain-error.js';
class ShippingPolicyDto {
  @ApiProperty({ enum: ['REQUESTER', 'RECIPIENT'] })
  @IsIn(['REQUESTER', 'RECIPIENT'])
  payer!: 'REQUESTER' | 'RECIPIENT';
  @ApiProperty({ minimum: 1 }) @IsInt() @Min(1) expectedRevision!: number;
}
class ShippingPolicyResponse {
  @ApiProperty({ enum: ['REQUESTER', 'RECIPIENT'] }) payer!: string;
  @ApiProperty({ minimum: 1 }) revision!: number;
}
@ApiTags('Admin shipping policy')
@ApiBearerAuth()
@UseGuards(AccessGuard, RolesGuard)
@Roles('SUPER_ADMIN')
@ApiResponse({ status: 200, type: ShippingPolicyResponse })
@ApiResponse({ status: 403, description: 'Se requiere SUPER_ADMIN humano.' })
@ApiResponse({
  status: 409,
  description: 'SHIPPING_POLICY_REVISION_CONFLICT o IDEMPOTENCY_KEY_REUSED.',
})
@Controller('admin/integrations/:id/shipping-policy')
export class ShippingPolicyController {
  constructor(private readonly db: PrismaService) {}
  @Get()
  @ApiOperation({
    summary:
      'Consultar pagador predeterminado B2B y revisión; no altera solicitudes históricas',
  })
  async get(@Param('id', new ParseUUIDPipe()) id: string) {
    const c = await this.db.integrationClient.findUnique({
      where: { id },
      select: { defaultShippingPayer: true, shippingPolicyRevision: true },
    });
    if (!c) throw new NotFoundException();
    return {
      payer: c.defaultShippingPayer,
      revision: c.shippingPolicyRevision,
    };
  }
  @Post()
  @HttpCode(200)
  @ApiHeader({
    name: 'Idempotency-Key',
    required: true,
    description:
      'UUID propio del administrador; replay conserva revisión original.',
  })
  @ApiOperation({
    summary:
      'Cambiar política para nuevas solicitudes; cambio invalida MPQ todavía no convertidas',
  })
  async set(
    @Req() req: AuthenticatedRequest,
    @Param('id', new ParseUUIDPipe()) id: string,
    @Headers('idempotency-key') key: string,
    @Body() body: ShippingPolicyDto,
  ) {
    if (!isUUID(key))
      throw new BadRequestException('UUID Idempotency-Key required');
    const hash = fingerprint('shipping.policy', { id, ...body });
    return this.db.$transaction(async (tx) => {
      await tx.$queryRaw`SELECT id FROM "IntegrationClient" WHERE id=${id}::uuid FOR UPDATE`;
      const client = await tx.integrationClient.findUnique({ where: { id } });
      if (!client) throw new NotFoundException();
      const old = await tx.shippingPolicyAudit.findUnique({
        where: { actorUserId_key: { actorUserId: req.user.id, key } },
      });
      if (old) {
        if (old.requestHash !== hash)
          throw new DomainException(
            'IDEMPOTENCY_KEY_REUSED',
            409,
            'Key already used',
          );
        return { payer: old.payer, revision: old.revision };
      }
      if (client.shippingPolicyRevision !== body.expectedRevision)
        throw new DomainException(
          'SHIPPING_POLICY_REVISION_CONFLICT',
          409,
          'Policy changed',
        );
      const next = await tx.integrationClient.update({
        where: { id },
        data: {
          defaultShippingPayer: body.payer,
          shippingPolicyRevision: { increment: 1 },
        },
      });
      await tx.shippingPolicyAudit.create({
        data: {
          integrationClientId: id,
          actorUserId: req.user.id,
          key,
          requestHash: hash,
          previousPayer: client.defaultShippingPayer,
          payer: body.payer,
          revision: next.shippingPolicyRevision,
        },
      });
      return {
        payer: next.defaultShippingPayer,
        revision: next.shippingPolicyRevision,
      };
    });
  }
}
