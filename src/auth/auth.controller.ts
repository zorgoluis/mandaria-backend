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
  ApiTags,
  ApiOkResponse,
  ApiNoContentResponse,
  ApiUnauthorizedResponse,
} from '@nestjs/swagger';
import { Throttle } from '@nestjs/throttler';
import { AuthService } from './auth.service.js';
import { LoginDto, RefreshDto } from './auth.dto.js';
import { AccessGuard } from './auth.guards.js';
import type { AuthenticatedRequest } from './auth.guards.js';
@ApiTags('Auth')
@ApiUnauthorizedResponse({
  description: 'Credenciales inválidas o sesión revocada',
})
@Controller('auth')
export class AuthController {
  constructor(private readonly auth: AuthService) {}
  @Post('login')
  @HttpCode(200)
  @Throttle({ default: { limit: 5, ttl: 60000 } })
  @ApiOkResponse({ description: 'Access y refresh tokens' })
  login(@Body() dto: LoginDto) {
    return this.auth.login(dto.email, dto.password);
  }
  @Post('refresh')
  @HttpCode(200)
  @Throttle({ default: { limit: 20, ttl: 60000 } })
  @ApiOkResponse({ description: 'Tokens nuevos; refresh anterior revocado' })
  refresh(@Body() dto: RefreshDto) {
    return this.auth.refresh(dto.refreshToken);
  }
  @Post('logout')
  @HttpCode(204)
  @ApiNoContentResponse({ description: 'Refresh revocado' })
  logout(@Body() dto: RefreshDto) {
    return this.auth.logout(dto.refreshToken);
  }
  @Get('me')
  @UseGuards(AccessGuard)
  @ApiBearerAuth()
  @ApiOkResponse({ description: 'Perfil público del usuario actual' })
  me(@Req() req: AuthenticatedRequest) {
    return req.user;
  }
}
