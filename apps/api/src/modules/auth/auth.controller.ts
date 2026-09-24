import { Body, Controller, Get, HttpCode, Post, Req, Res } from '@nestjs/common';
import { ApiOkResponse, ApiOperation, ApiTags } from '@nestjs/swagger';
import { Throttle } from '@nestjs/throttler';
import type { Request, Response } from 'express';
import { Ctx, type RequestContext, type RequestWithContext } from '../../common/request-context.js';
import { Public, SkipCsrf } from './auth.decorators.js';
import { clientIp } from './auth.guard.js';
import { AuthService } from './auth.service.js';
import { ChangePasswordDto, ForgotPasswordDto, LoginDto, LoginResultDto, OkDto, ResetPasswordDto, RevokeSessionsDto, SessionInfoDto } from './dto/auth.dto.js';

@ApiTags('auth')
@Controller('auth')
export class AuthController {
  constructor(private readonly auth: AuthService) {}

  @Post('login')
  @Public()
  @SkipCsrf()
  @HttpCode(200)
  @Throttle({ default: { limit: 10, ttl: 60_000 } })
  @ApiOperation({ summary: 'Connexion : ouvre une session serveur (cookie HttpOnly) et renvoie le profil.' })
  @ApiOkResponse({ type: LoginResultDto })
  async login(@Body() dto: LoginDto, @Req() req: RequestWithContext, @Res({ passthrough: true }) res: Response): Promise<SessionInfoDto> {
    return this.auth.login(dto, res, { ipAddress: clientIp(req), userAgent: req.header('user-agent') ?? null, requestId: req.requestId });
  }

  @Post('logout')
  @HttpCode(200)
  @ApiOperation({ summary: 'Déconnexion : révoque la session courante.' })
  @ApiOkResponse({ type: OkDto })
  async logout(@Ctx() ctx: RequestContext, @Res({ passthrough: true }) res: Response): Promise<OkDto> {
    await this.auth.logout(ctx, res);
    return { ok: true };
  }

  @Get('session')
  @ApiOperation({ summary: 'Profil de la session courante, habilitations et sociétés visibles.' })
  @ApiOkResponse({ type: SessionInfoDto })
  async session(@Ctx() ctx: RequestContext): Promise<SessionInfoDto> {
    return this.auth.sessionInfo(ctx);
  }

  @Post('forgot-password')
  @Public()
  @SkipCsrf()
  @HttpCode(200)
  @Throttle({ default: { limit: 5, ttl: 60_000 } })
  @ApiOperation({ summary: 'Demande de réinitialisation (réponse identique que l’adresse existe ou non).' })
  @ApiOkResponse({ type: OkDto })
  async forgotPassword(@Body() dto: ForgotPasswordDto): Promise<OkDto> {
    await this.auth.forgotPassword(dto.email);
    return { ok: true };
  }

  @Post('reset-password')
  @Public()
  @SkipCsrf()
  @HttpCode(200)
  @Throttle({ default: { limit: 5, ttl: 60_000 } })
  @ApiOperation({ summary: 'Définit un nouveau mot de passe à partir d’un jeton à usage unique.' })
  @ApiOkResponse({ type: OkDto })
  async resetPassword(@Body() dto: ResetPasswordDto): Promise<OkDto> {
    await this.auth.resetPassword(dto.token, dto.newPassword);
    return { ok: true };
  }

  @Post('change-password')
  @HttpCode(200)
  @ApiOperation({ summary: 'Change le mot de passe de l’utilisateur connecté et révoque ses autres sessions.' })
  @ApiOkResponse({ type: OkDto })
  async changePassword(@Ctx() ctx: RequestContext, @Body() dto: ChangePasswordDto): Promise<OkDto> {
    await this.auth.changePassword(ctx, dto.currentPassword, dto.newPassword);
    return { ok: true };
  }

  @Post('revoke-sessions')
  @HttpCode(200)
  @ApiOperation({ summary: 'Révoque les sessions (soi-même, ou un autre utilisateur pour l’administrateur).' })
  @ApiOkResponse({ schema: { properties: { revoked: { type: 'number' } } } })
  async revokeSessions(@Ctx() ctx: RequestContext, @Body() dto: RevokeSessionsDto, @Req() _req: Request): Promise<{ revoked: number }> {
    const revoked = await this.auth.revokeSessions(ctx, dto.userId, dto.keepCurrent);
    return { revoked };
  }
}
