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
  Req,
  UseGuards,
} from '@nestjs/common';
import {
  ApiBearerAuth,
  ApiCreatedResponse,
  ApiForbiddenResponse,
  ApiNoContentResponse,
  ApiOkResponse,
  ApiOperation,
  ApiTags,
  ApiUnauthorizedResponse,
} from '@nestjs/swagger';
import { AccessGuard, Roles, RolesGuard } from '../auth/auth.guards.js';
import type { AuthenticatedRequest } from '../auth/auth.guards.js';
import { IntegrationsService } from './integrations.service.js';
import {
  CreateCredentialDto,
  CreateIntegrationDto,
  CredentialCreatedResponse,
  CredentialResponse,
  IntegrationResponse,
  IntegrationListResponse,
  UpdateIntegrationDto,
} from './integrations.dto.js';

@ApiTags('Admin IntegrationClients')
@ApiBearerAuth()
@ApiUnauthorizedResponse({ description: 'Requires a human access token' })
@ApiForbiddenResponse({ description: 'Requires SUPER_ADMIN' })
@UseGuards(AccessGuard, RolesGuard)
@Roles('SUPER_ADMIN')
@Controller(['admin/integrations', 'integrations'])
export class AdminIntegrationsController {
  constructor(private readonly integrations: IntegrationsService) {}
  @Get()
  @ApiOkResponse({ type: IntegrationListResponse, isArray: true })
  @ApiOperation({
    summary:
      'List up to 100 clients; /integrations administrative routes are compatibility aliases',
  })
  list() {
    return this.integrations.list();
  }
  @Get(':id')
  @ApiOkResponse({ type: IntegrationResponse })
  get(@Param('id', new ParseUUIDPipe()) id: string) {
    return this.integrations.get(id);
  }
  @Post()
  @ApiCreatedResponse({ type: IntegrationResponse })
  create(@Body() dto: CreateIntegrationDto, @Req() req: AuthenticatedRequest) {
    return this.integrations.create(dto, req.user.id);
  }
  @Patch(':id')
  @HttpCode(204)
  @ApiNoContentResponse({
    description: 'ACTIVE/SUSPENDED reversible; REVOKED terminal',
  })
  status(
    @Param('id', new ParseUUIDPipe()) id: string,
    @Body() dto: UpdateIntegrationDto,
    @Req() req: AuthenticatedRequest,
  ) {
    return this.integrations.setStatus(id, dto.status, req.user.id);
  }
  @Post(':id/credentials')
  @ApiCreatedResponse({ type: CredentialCreatedResponse })
  @ApiOperation({
    summary: 'Generate Client Credentials; secret shown only in this response',
  })
  credential(
    @Param('id', new ParseUUIDPipe()) id: string,
    @Body() dto: CreateCredentialDto,
    @Req() req: AuthenticatedRequest,
  ) {
    return this.integrations.createCredential(id, dto, req.user.id);
  }
  @Get(':id/credentials')
  @ApiOkResponse({ type: CredentialResponse, isArray: true })
  credentials(@Param('id', new ParseUUIDPipe()) id: string) {
    return this.integrations.listCredentials(id);
  }
  @Post(':id/credentials/:credentialId/rotate')
  @ApiCreatedResponse({ type: CredentialCreatedResponse })
  @ApiOperation({
    summary:
      'Create replacement with the same scopes/expiry; revoke old credential explicitly after transition',
  })
  rotate(
    @Param('id', new ParseUUIDPipe()) id: string,
    @Param('credentialId', new ParseUUIDPipe()) credentialId: string,
    @Req() req: AuthenticatedRequest,
  ) {
    return this.integrations.rotate(id, credentialId, req.user.id);
  }
  @Post(':id/credentials/:credentialId/revoke')
  @HttpCode(204)
  @ApiNoContentResponse()
  revoke(
    @Param('id', new ParseUUIDPipe()) id: string,
    @Param('credentialId', new ParseUUIDPipe()) credentialId: string,
    @Req() req: AuthenticatedRequest,
  ) {
    return this.integrations.revoke(id, credentialId, req.user.id);
  }
  @Delete(':id/credentials/:credentialId')
  @HttpCode(204)
  @ApiNoContentResponse()
  @ApiOperation({
    summary: 'Compatibility alias for credential revocation',
    deprecated: true,
  })
  legacyRevoke(
    @Param('id', new ParseUUIDPipe()) id: string,
    @Param('credentialId', new ParseUUIDPipe()) credentialId: string,
    @Req() req: AuthenticatedRequest,
  ) {
    return this.integrations.revoke(id, credentialId, req.user.id);
  }
}
