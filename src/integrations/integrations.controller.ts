import {
  Body,
  Controller,
  Get,
  HttpCode,
  Post,
  Req,
  UseGuards,
} from '@nestjs/common';
import {
  ApiBearerAuth,
  ApiOkResponse,
  ApiOperation,
  ApiTags,
  ApiTooManyRequestsResponse,
  ApiUnauthorizedResponse,
} from '@nestjs/swagger';
import { Throttle } from '@nestjs/throttler';
import { IntegrationAuthService } from './integration-auth.service.js';
import { IntegrationGuard } from './integration.guard.js';
import type { IntegrationRequest } from './integration.guard.js';
import {
  IntegrationMeResponse,
  IntegrationTokenDto,
  IntegrationTokenResponse,
} from './integrations.dto.js';
import {
  IntegrationScopes,
  IntegrationScopesGuard,
} from './integration-scopes.js';

@ApiTags('Integration authentication')
@Controller('integrations')
export class IntegrationsController {
  constructor(private readonly auth: IntegrationAuthService) {}
  @Post('token')
  @HttpCode(200)
  @Throttle({ default: { limit: 10, ttl: 60000 } })
  @ApiOperation({
    summary:
      'Exchange Client Credentials for a short-lived B2B token; no refresh token',
  })
  @ApiOkResponse({ type: IntegrationTokenResponse })
  @ApiUnauthorizedResponse({
    description: 'Invalid integration credentials (generic)',
  })
  @ApiTooManyRequestsResponse({ description: '10 requests per minute per IP' })
  token(@Body() dto: IntegrationTokenDto) {
    return this.auth.token(dto.clientId, dto.clientSecret);
  }
  @Get('me')
  @UseGuards(IntegrationGuard)
  @ApiBearerAuth('integration-bearer')
  @ApiOkResponse({ type: IntegrationMeResponse })
  @ApiUnauthorizedResponse({
    description: 'Invalid, expired, revoked or suspended integration identity',
  })
  me(@Req() req: IntegrationRequest) {
    return req.integration;
  }
  @Get('scope-check')
  @UseGuards(IntegrationGuard, IntegrationScopesGuard)
  @IntegrationScopes('deliveries:read')
  @ApiBearerAuth('integration-bearer')
  @ApiOperation({
    summary:
      'Authorization probe for deliveries:read; does not access or implement deliveries',
  })
  @ApiOkResponse({
    schema: {
      type: 'object',
      properties: {
        authorized: { type: 'boolean' },
        scope: { type: 'string' },
      },
    },
  })
  checkScope() {
    return { authorized: true, scope: 'deliveries:read' };
  }
}
