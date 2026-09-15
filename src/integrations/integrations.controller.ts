import {
  Body,
  Controller,
  Delete,
  Get,
  Header,
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
  ApiSecurity,
  ApiTags,
  ApiOperation,
} from '@nestjs/swagger';
import { AccessGuard, Roles, RolesGuard } from '../auth/auth.guards.js';
import type { AuthenticatedRequest } from '../auth/auth.guards.js';
import { IntegrationsService } from './integrations.service.js';
import {
  CreateIntegrationDto,
  UpdateIntegrationDto,
} from './integrations.dto.js';
import { IntegrationGuard } from './integration.guard.js';
import type { IntegrationRequest } from './integration.guard.js';
@ApiTags('Integrations')
@Controller('integrations')
export class IntegrationsController {
  constructor(private readonly integrations: IntegrationsService) {}
  @Get('me')
  @UseGuards(IntegrationGuard)
  @ApiSecurity('integration-key')
  @ApiOperation({ summary: 'Verifica la identidad de un sistema externo' })
  me(@Req() req: IntegrationRequest) {
    return req.integration;
  }
  @Get()
  @UseGuards(AccessGuard, RolesGuard)
  @Roles('SUPER_ADMIN')
  @ApiBearerAuth()
  list() {
    return this.integrations.list();
  }
  @Post()
  @UseGuards(AccessGuard, RolesGuard)
  @Roles('SUPER_ADMIN')
  @ApiBearerAuth()
  create(@Body() dto: CreateIntegrationDto, @Req() req: AuthenticatedRequest) {
    return this.integrations.create(dto, req.user.id);
  }
  @Patch(':id')
  @HttpCode(204)
  @UseGuards(AccessGuard, RolesGuard)
  @Roles('SUPER_ADMIN')
  @ApiBearerAuth()
  status(
    @Param('id', new ParseUUIDPipe()) id: string,
    @Body() dto: UpdateIntegrationDto,
    @Req() req: AuthenticatedRequest,
  ) {
    return this.integrations.setStatus(id, dto.status, req.user.id);
  }
  @Post(':id/credentials')
  @Header('Cache-Control', 'no-store')
  @UseGuards(AccessGuard, RolesGuard)
  @Roles('SUPER_ADMIN')
  @ApiBearerAuth()
  @ApiOperation({
    summary: 'Genera una API key; el secreto se entrega una sola vez',
  })
  credential(
    @Param('id', new ParseUUIDPipe()) id: string,
    @Req() req: AuthenticatedRequest,
  ) {
    return this.integrations.createCredential(id, req.user.id);
  }
  @Delete(':id/credentials/:credentialId')
  @HttpCode(204)
  @UseGuards(AccessGuard, RolesGuard)
  @Roles('SUPER_ADMIN')
  @ApiBearerAuth()
  revoke(
    @Param('id', new ParseUUIDPipe()) id: string,
    @Param('credentialId', new ParseUUIDPipe()) credentialId: string,
    @Req() req: AuthenticatedRequest,
  ) {
    return this.integrations.revoke(id, credentialId, req.user.id);
  }
}
