import {
  administrationSchema,
  adminApplicationSchema,
  applicationSchema,
  applicationPageSchema,
  businessReceiptSchema,
  businessAttemptSchema,
  businessErrorSchema,
} from './business.openapi.js';
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
  Res,
  UseGuards,
} from '@nestjs/common';
import {
  ApiBearerAuth,
  ApiHeader,
  ApiOperation,
  ApiResponse,
  ApiTags,
} from '@nestjs/swagger';
import type { Response } from 'express';
import {
  AccessGuard,
  Roles,
  RolesGuard,
  type AuthenticatedRequest,
} from '../auth/auth.guards.js';
import { DomainException } from '../common/domain-error.js';
import { BusinessService, businessReceipt } from './business.service.js';
import {
  AdminBusinessAttemptDto,
  AdminBusinessPageDto,
  AllowBusinessDto,
  BusinessAttemptDto,
  BusinessPageDto,
  DecisionBusinessDto,
  RevokeBusinessDto,
  SubmitBusinessDto,
  WithdrawBusinessDto,
} from './business.dto.js';
export function businessResult(
  result: Awaited<ReturnType<BusinessService['command']>>,
  res: Response,
  close = false,
) {
  if (result.replayed) res.setHeader('Idempotent-Replayed', 'true');
  const receipt = businessReceipt(result.receipt);
  if (close) return { state: receipt.outcome, receipt };
  res.status(result.receipt.httpStatus);
  if (receipt.outcome !== 'APPLIED') {
    const error = new DomainException(receipt.code!, 409, receipt.code!);
    Object.assign(error, { businessReceipt: receipt });
    throw error;
  }
  return receipt;
}
function noQuery(req: AuthenticatedRequest) {
  if (Object.keys(req.query).length)
    throw new DomainException('VALIDATION_ERROR', 400, 'Query not allowed');
}
@ApiTags('Customer business applications')
@ApiBearerAuth()
@UseGuards(AccessGuard)
@ApiResponse({
  status: 409,
  schema: businessErrorSchema,
  description:
    'Business precondition rejected; receipt contains durable outcome. GET attempt recovers the original result.',
})
@Controller('customer')
export class CustomerBusinessController {
  constructor(private readonly service: BusinessService) {}
  @ApiResponse({ status: 201, schema: businessReceiptSchema })
  @Post('business-applications')
  @ApiOperation({
    summary:
      'Request manual business approval; does not activate business access',
  })
  @ApiHeader({ name: 'Idempotency-Key', required: true })
  @ApiResponse({ status: 200, schema: businessReceiptSchema })
  async submit(
    @Req() req: AuthenticatedRequest,
    @Body() dto: SubmitBusinessDto,
    @Headers('idempotency-key') key: string,
    @Res({ passthrough: true }) res: Response,
  ) {
    return businessResult(
      await this.service.command(
        req,
        await this.service.ownAccount(req.user.id),
        'SUBMIT',
        undefined,
        key,
        dto,
      ),
      res,
    );
  }
  @ApiResponse({ status: 200, schema: applicationPageSchema() })
  @Get('business-applications')
  @ApiOperation({ summary: 'List own immutable business application history' })
  async list(@Req() req: AuthenticatedRequest, @Query() q: BusinessPageDto) {
    return this.service.list(
      q.page,
      q.pageSize,
      q.status,
      await this.service.ownAccount(req.user.id),
    );
  }
  @ApiResponse({ status: 200, schema: applicationSchema })
  @Get('business-applications/:id')
  @ApiOperation({ summary: 'Read own application; no internal notes' })
  async detail(
    @Req() req: AuthenticatedRequest,
    @Param('id', new ParseUUIDPipe({ version: '4' })) id: string,
  ) {
    return this.service.detail(id, await this.service.ownAccount(req.user.id));
  }
  @Post('business-applications/:id/withdraw')
  @HttpCode(200)
  @ApiOperation({
    summary: 'Withdraw pending application without cancelling services',
  })
  @ApiHeader({ name: 'Idempotency-Key', required: true })
  @ApiResponse({ status: 200, schema: businessReceiptSchema })
  async withdraw(
    @Req() req: AuthenticatedRequest,
    @Param('id', new ParseUUIDPipe({ version: '4' })) id: string,
    @Body() dto: WithdrawBusinessDto,
    @Headers('idempotency-key') key: string,
    @Res({ passthrough: true }) res: Response,
  ) {
    return businessResult(
      await this.service.command(
        req,
        await this.service.ownAccount(req.user.id),
        'WITHDRAW',
        id,
        key,
        dto,
      ),
      res,
    );
  }
  @ApiResponse({ status: 200, schema: businessAttemptSchema })
  @Get('business-application-attempts/:key')
  @ApiOperation({
    summary: 'Read own commercial receipt; NOT_OBSERVED does not prove failure',
  })
  async attempt(
    @Req() req: AuthenticatedRequest,
    @Param('key') key: string,
    @Query() dto: BusinessAttemptDto,
  ) {
    return this.service.attempt(
      req,
      await this.service.ownAccount(req.user.id),
      dto.operation,
      dto.target,
      key,
    );
  }
  @ApiResponse({ status: 200, schema: businessAttemptSchema })
  @Post('business-application-attempts/:key/close')
  @HttpCode(200)
  @ApiOperation({
    summary:
      'Fence own unobserved commercial command; does not undo applied results',
  })
  async close(
    @Req() req: AuthenticatedRequest,
    @Param('key') key: string,
    @Body() dto: BusinessAttemptDto,
    @Res({ passthrough: true }) res: Response,
  ) {
    noQuery(req);
    return businessResult(
      await this.service.command(
        req,
        await this.service.ownAccount(req.user.id),
        dto.operation,
        dto.target,
        key,
        {},
        false,
        true,
      ),
      res,
      true,
    );
  }
}
@ApiTags('Admin customer business approval')
@ApiBearerAuth()
@UseGuards(AccessGuard, RolesGuard)
@Roles('SUPER_ADMIN')
@ApiResponse({
  status: 409,
  schema: businessErrorSchema,
  description:
    'Revision, pending application or open requests conflict; durable receipt when applicable',
})
@Controller('admin')
export class AdminBusinessController {
  constructor(private readonly service: BusinessService) {}
  @ApiResponse({ status: 200, schema: applicationPageSchema(true) })
  @Get('customer-business-applications')
  @ApiOperation({
    summary: 'Review customer business applications; SUPER_ADMIN only',
  })
  list(@Query() q: AdminBusinessPageDto) {
    return this.service.list(
      q.page,
      q.pageSize,
      q.status,
      q.customerAccountId,
      true,
    );
  }
  @ApiResponse({ status: 200, schema: adminApplicationSchema })
  @Get('customer-business-applications/:id')
  @ApiOperation({
    summary: 'Read application and administrative access/grant details',
  })
  detail(@Param('id', new ParseUUIDPipe({ version: '4' })) id: string) {
    return this.service.detail(id);
  }
  @Post('customer-business-applications/:id/decision')
  @HttpCode(200)
  @ApiOperation({
    summary: 'Approve atomically only with zero open requests, or reject',
  })
  @ApiHeader({ name: 'Idempotency-Key', required: true })
  @ApiResponse({ status: 200, schema: businessReceiptSchema })
  async decision(
    @Req() req: AuthenticatedRequest,
    @Param('id', new ParseUUIDPipe({ version: '4' })) id: string,
    @Body() dto: DecisionBusinessDto,
    @Headers('idempotency-key') key: string,
    @Res({ passthrough: true }) res: Response,
  ) {
    return businessResult(
      await this.service.command(
        req,
        await this.service.applicationAccount(id),
        'DECIDE',
        id,
        key,
        dto,
        true,
      ),
      res,
    );
  }
  @ApiResponse({ status: 200, schema: administrationSchema })
  @Get('customer-business-access/:customerAccountId')
  @ApiOperation({
    summary: 'Read access administration and current grant identifiers',
  })
  access(
    @Req() req: AuthenticatedRequest,
    @Param('customerAccountId', new ParseUUIDPipe({ version: '4' })) id: string,
  ) {
    return this.service.readAccess(req, id);
  }
  @Post('customer-business-access/:customerAccountId/revoke')
  @HttpCode(200)
  @ApiOperation({
    summary: 'Revoke commercial access preserving committed services',
  })
  @ApiHeader({ name: 'Idempotency-Key', required: true })
  @ApiResponse({ status: 200, schema: businessReceiptSchema })
  async revoke(
    @Req() req: AuthenticatedRequest,
    @Param('customerAccountId', new ParseUUIDPipe({ version: '4' })) id: string,
    @Body() dto: RevokeBusinessDto,
    @Headers('idempotency-key') key: string,
    @Res({ passthrough: true }) res: Response,
  ) {
    return businessResult(
      await this.service.command(req, id, 'REVOKE', id, key, dto, true),
      res,
    );
  }
  @Post('customer-business-access/:customerAccountId/allow-reapplication')
  @HttpCode(200)
  @ApiOperation({
    summary:
      'Allow a new application after administrative revocation; does not activate business',
  })
  @ApiHeader({ name: 'Idempotency-Key', required: true })
  @ApiResponse({ status: 200, schema: businessReceiptSchema })
  async allow(
    @Req() req: AuthenticatedRequest,
    @Param('customerAccountId', new ParseUUIDPipe({ version: '4' })) id: string,
    @Body() dto: AllowBusinessDto,
    @Headers('idempotency-key') key: string,
    @Res({ passthrough: true }) res: Response,
  ) {
    return businessResult(
      await this.service.command(
        req,
        id,
        'ALLOW_REAPPLICATION',
        id,
        key,
        dto,
        true,
      ),
      res,
    );
  }
  @ApiResponse({ status: 200, schema: businessAttemptSchema })
  @Get('customer-business-application-attempts/:key')
  @ApiOperation({ summary: 'Recover own administrator commercial receipt' })
  attempt(
    @Req() req: AuthenticatedRequest,
    @Param('key') key: string,
    @Query() dto: AdminBusinessAttemptDto,
  ) {
    return this.service.attempt(
      req,
      dto.customerAccountId,
      dto.operation,
      dto.target,
      key,
      true,
    );
  }
  @ApiResponse({ status: 200, schema: businessAttemptSchema })
  @Post('customer-business-application-attempts/:key/close')
  @HttpCode(200)
  @ApiOperation({
    summary:
      'Fence own administrator command; another administrator cannot close it',
  })
  async close(
    @Req() req: AuthenticatedRequest,
    @Param('key') key: string,
    @Body() dto: AdminBusinessAttemptDto,
    @Res({ passthrough: true }) res: Response,
  ) {
    noQuery(req);
    return businessResult(
      await this.service.command(
        req,
        dto.customerAccountId,
        dto.operation,
        dto.target,
        key,
        {},
        true,
        true,
      ),
      res,
      true,
    );
  }
}
