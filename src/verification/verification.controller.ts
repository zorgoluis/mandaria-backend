import {
  VerificationTermsResponse,
  VerificationAcceptanceResponse,
  VerificationCaseResponse,
  VerificationUploadResponse,
  VerificationAttemptResponse,
} from './verification.responses.js';
import { VerificationEmailConfirmDto } from './verification.dto.js';
import {
  Body,
  Controller,
  Delete,
  Get,
  Header,
  Headers,
  HttpCode,
  Param,
  ParseUUIDPipe,
  Patch,
  Post,
  Query,
  Req,
  Res,
  UseGuards,
  StreamableFile,
} from '@nestjs/common';
import {
  ApiBearerAuth,
  ApiConsumes,
  ApiHeader,
  ApiOperation,
  ApiProduces,
  ApiResponse,
  ApiTags,
} from '@nestjs/swagger';
import { Throttle } from '@nestjs/throttler';
import type { Response } from 'express';
import {
  AccessGuard,
  RolesGuard,
  Roles,
  type AuthenticatedRequest,
} from '../auth/auth.guards.js';
import { VerificationService } from './verification.service.js';
import {
  AcceptTermsDto,
  AttemptDto,
  CreateCaseDto,
  DecisionDto,
  OnboardingVehicleDto,
  PolicyDto,
  ReceiptDto,
  RegistrationConfirmDto,
  RegistrationDto,
  RevisionDto,
  TermsQueryDto,
  UpdateCaseDto,
  UploadDto,
  VerificationListDto,
} from './verification.dto.js';
const keyHeader = {
  name: 'Idempotency-Key',
  required: true,
  description:
    'UUID for this intent. Reuse exactly after timeout; query/close via verification-command-attempts.',
};
@ApiTags('Driver verification registration (LOCAL TEST ONLY)')
@Controller('independent-driver-registrations')
@Throttle({ default: { limit: 5, ttl: 60000 } })
export class DriverRegistrationController {
  constructor(private readonly service: VerificationService) {}
  @Post()
  @HttpCode(202)
  @ApiOperation({
    summary: 'LOCAL TEST ONLY: request an independent registration email',
  })
  register(@Body() dto: RegistrationDto) {
    return this.service.register(dto.email);
  }
  @Post('resend') @HttpCode(202) resend(@Body() dto: RegistrationDto) {
    return this.service.register(dto.email);
  }
  @Post('confirm') @HttpCode(200) confirm(@Body() dto: RegistrationConfirmDto) {
    return this.service.confirm(dto);
  }
}
@ApiTags('Driver verification (LOCAL TEST ONLY)')
@ApiBearerAuth()
@UseGuards(AccessGuard, RolesGuard)
@Roles('DRIVER', 'PROVIDER_ADMIN', 'SUPER_ADMIN')
@Controller()
export class VerificationController {
  constructor(private readonly service: VerificationService) {}
  @Post('verification-email/request')
  @HttpCode(202)
  @Roles('DRIVER', 'PROVIDER_ADMIN')
  @Throttle({ default: { limit: 5, ttl: 60000 } })
  requestEmail(@Req() req: AuthenticatedRequest) {
    return this.service.requestEmailVerification(req.user.id);
  }
  @Post('verification-email/confirm')
  @HttpCode(200)
  @Roles('DRIVER', 'PROVIDER_ADMIN')
  @Throttle({ default: { limit: 5, ttl: 60000 } })
  confirmEmail(
    @Req() req: AuthenticatedRequest,
    @Body() dto: VerificationEmailConfirmDto,
  ) {
    return this.service.confirmEmail(req.user.id, dto.token);
  }
  @Get('verification-requirements') requirements() {
    return this.service.requirements();
  }
  @ApiResponse({ status: 200, type: VerificationTermsResponse })
  @Get('verification-terms')
  terms(@Req() req: AuthenticatedRequest, @Query() dto: TermsQueryDto) {
    return this.service.terms(req.user.id, dto);
  }
  @ApiResponse({ status: 200, type: VerificationAcceptanceResponse })
  @Post('verification-terms/accept')
  @HttpCode(200)
  @ApiHeader(keyHeader)
  accept(
    @Req() req: AuthenticatedRequest,
    @Headers('idempotency-key') key: string,
    @Body() dto: AcceptTermsDto,
  ) {
    return this.service.acceptTerms(req.user.id, key, dto);
  }
  @Get('verification-terms/acceptances/:id') receipt(
    @Req() req: AuthenticatedRequest,
    @Param('id', ParseUUIDPipe) id: string,
  ) {
    return this.service.acceptance(req.user.id, id);
  }
  @Get('driver/onboarding') @Roles('DRIVER') onboarding(
    @Req() req: AuthenticatedRequest,
  ) {
    return this.service.onboarding(req.user.id);
  }
  @Post('driver/onboarding/vehicles')
  @Roles('DRIVER')
  @ApiHeader(keyHeader)
  @ApiResponse({ status: 201, type: ReceiptDto })
  vehicle(
    @Req() req: AuthenticatedRequest,
    @Headers('idempotency-key') key: string,
    @Body() dto: OnboardingVehicleDto,
  ) {
    return this.service.createVehicle(req.user.id, key, dto);
  }
  @Post('driver/verification-cases')
  @Roles('DRIVER')
  @ApiHeader(keyHeader)
  @ApiResponse({ status: 201, type: ReceiptDto })
  driverCase(
    @Req() req: AuthenticatedRequest,
    @Headers('idempotency-key') key: string,
    @Body() dto: CreateCaseDto,
  ) {
    return this.service.createCase(req.user.id, key, dto);
  }
  @Post('provider/verification-cases')
  @Roles('PROVIDER_ADMIN')
  @ApiHeader(keyHeader)
  @ApiResponse({ status: 201, type: ReceiptDto })
  providerCase(
    @Req() req: AuthenticatedRequest,
    @Headers('idempotency-key') key: string,
    @Body() dto: CreateCaseDto,
  ) {
    return this.service.createCase(req.user.id, key, dto);
  }
  @Get('driver/verification-cases') @Roles('DRIVER') driverCases(
    @Req() req: AuthenticatedRequest,
    @Query() dto: VerificationListDto,
  ) {
    return this.service.list(req.user.id, dto);
  }
  @Get('provider/verification-cases') @Roles('PROVIDER_ADMIN') providerCases(
    @Req() req: AuthenticatedRequest,
    @Query() dto: VerificationListDto,
  ) {
    return this.service.list(req.user.id, dto);
  }
  @Get('admin/verification-cases') @Roles('SUPER_ADMIN') adminCases(
    @Req() req: AuthenticatedRequest,
    @Query() dto: VerificationListDto,
  ) {
    return this.service.list(req.user.id, dto, true);
  }
  @ApiResponse({ status: 200, type: VerificationCaseResponse })
  @Get('verification-cases/:id')
  get(
    @Req() req: AuthenticatedRequest,
    @Param('id', ParseUUIDPipe) id: string,
  ) {
    return this.service.getCase(req.user.id, id);
  }
  @Patch('verification-cases/:id') @ApiHeader(keyHeader) update(
    @Req() req: AuthenticatedRequest,
    @Headers('idempotency-key') key: string,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: UpdateCaseDto,
  ) {
    return this.service.updateCase(req.user.id, key, id, dto);
  }
  @ApiResponse({ status: 201, type: VerificationUploadResponse })
  @Post('verification-cases/:id/uploads')
  @ApiHeader(keyHeader)
  @ApiOperation({
    summary:
      'Create private upload; PUT bytes to returned URL as application/octet-stream, then complete. Only JPEG/PNG supported.',
  })
  upload(
    @Req() req: AuthenticatedRequest,
    @Headers('idempotency-key') key: string,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: UploadDto,
  ) {
    return this.service.upload(req.user.id, key, id, dto);
  }
  @Post('verification-cases/:id/uploads/:uploadId/complete')
  @HttpCode(200)
  @ApiHeader(keyHeader)
  complete(
    @Req() req: AuthenticatedRequest,
    @Headers('idempotency-key') key: string,
    @Param('id', ParseUUIDPipe) id: string,
    @Param('uploadId', ParseUUIDPipe) uploadId: string,
    @Body() dto: RevisionDto,
  ) {
    return this.service.complete(
      req.user.id,
      key,
      id,
      uploadId,
      dto.expectedVersion,
    );
  }
  @Get('verification-cases/:id/attachments') async attachments(
    @Req() req: AuthenticatedRequest,
    @Param('id', ParseUUIDPipe) id: string,
  ) {
    return (await this.service.getCase(req.user.id, id)).attachments;
  }
  @Post('verification-cases/:id/attachments/:attachmentId/access')
  @HttpCode(200)
  @ApiProduces('image/png')
  @ApiConsumes('application/json')
  @Header('Content-Disposition', 'inline; filename="evidence.png"')
  async access(
    @Req() req: AuthenticatedRequest,
    @Param('id', ParseUUIDPipe) id: string,
    @Param('attachmentId', ParseUUIDPipe) attachmentId: string,
    @Res({ passthrough: true }) res: Response,
  ) {
    res.setHeader('Content-Type', 'image/png');
    return new StreamableFile(
      await this.service.attachment(req.user.id, id, attachmentId),
    );
  }
  @Delete('verification-cases/:id/attachments/:attachmentId')
  @ApiHeader(keyHeader)
  remove(
    @Req() req: AuthenticatedRequest,
    @Headers('idempotency-key') key: string,
    @Param('id', ParseUUIDPipe) id: string,
    @Param('attachmentId', ParseUUIDPipe) attachmentId: string,
    @Body() dto: RevisionDto,
  ) {
    return this.service.removeAttachment(
      req.user.id,
      key,
      id,
      attachmentId,
      dto.expectedVersion,
    );
  }
  @Post('verification-cases/:id/submit')
  @HttpCode(200)
  @ApiHeader(keyHeader)
  submit(
    @Req() req: AuthenticatedRequest,
    @Headers('idempotency-key') key: string,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: RevisionDto,
  ) {
    return this.service.transition(
      req.user.id,
      key,
      id,
      dto.expectedVersion,
      'SUBMIT',
    );
  }
  @Post('verification-cases/:id/withdraw')
  @HttpCode(200)
  @ApiHeader(keyHeader)
  withdraw(
    @Req() req: AuthenticatedRequest,
    @Headers('idempotency-key') key: string,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: RevisionDto,
  ) {
    return this.service.transition(
      req.user.id,
      key,
      id,
      dto.expectedVersion,
      'WITHDRAW',
    );
  }
  @Post('admin/verification-cases/:id/decision')
  @Roles('SUPER_ADMIN')
  @HttpCode(200)
  @ApiHeader(keyHeader)
  decision(
    @Req() req: AuthenticatedRequest,
    @Headers('idempotency-key') key: string,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: DecisionDto,
  ) {
    return this.service.decide(req.user.id, key, id, dto);
  }
  @Get('driver/verification-notifications') @Roles('DRIVER') notifications(
    @Req() req: AuthenticatedRequest,
  ) {
    return this.service.notifications(req.user.id);
  }
  @Get('provider/verification-notifications')
  @Roles('PROVIDER_ADMIN')
  providerNotifications(@Req() req: AuthenticatedRequest) {
    return this.service.notifications(req.user.id);
  }
  @ApiResponse({ status: 200, type: VerificationAttemptResponse })
  @Get('verification-command-attempts/:key')
  attempt(
    @Req() req: AuthenticatedRequest,
    @Param('key', ParseUUIDPipe) key: string,
    @Query() dto: AttemptDto,
  ) {
    return this.service.attempt(req.user.id, key, dto);
  }
  @Post('verification-command-attempts/:key/close') @HttpCode(200) close(
    @Req() req: AuthenticatedRequest,
    @Param('key', ParseUUIDPipe) key: string,
    @Body() dto: AttemptDto,
  ) {
    return this.service.attempt(req.user.id, key, dto, true);
  }
  @Post('admin/verification-policy')
  @Roles('SUPER_ADMIN')
  @HttpCode(200)
  @ApiHeader(keyHeader)
  @ApiOperation({
    summary:
      'LOCAL TEST ONLY: durable admission cut. Does not cancel active assignments.',
  })
  policy(
    @Req() req: AuthenticatedRequest,
    @Headers('idempotency-key') key: string,
    @Body() dto: PolicyDto,
  ) {
    return this.service.activation(req.user.id, key, dto);
  }
}
