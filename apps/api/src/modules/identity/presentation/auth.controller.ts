import {
  Controller,
  Get,
  HttpCode,
  Post,
  Query,
  Req,
  Res,
  UnauthorizedException,
  UseGuards,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import type { FastifyReply, FastifyRequest } from 'fastify';

import type { Environment } from '../../../config/environment';
import { AuthService } from '../application/auth.service';
import type { AccessContext } from '../domain/access-context';
import { AccessTokenGuard } from './access-token.guard';
import { GoogleCallbackQueryDto, GoogleStartQueryDto } from './auth.dto';
import { CookieMutationGuard } from './cookie-mutation.guard';
import { CurrentAuth } from './current-auth.decorator';

@ApiTags('Authentication')
@Controller({ path: 'auth', version: '1' })
export class AuthController {
  private readonly cookieName: string;
  private readonly cookieSecure: boolean;
  private readonly refreshMaxAgeSeconds: number;
  private readonly webSuccessUrl: URL;

  constructor(
    private readonly auth: AuthService,
    config: ConfigService<Environment, true>,
  ) {
    this.cookieSecure = config.get('AUTH_COOKIE_SECURE', { infer: true });
    this.cookieName = this.cookieSecure ? '__Secure-voiceverse_refresh' : 'voiceverse_refresh';
    this.refreshMaxAgeSeconds = config.get('AUTH_REFRESH_TOKEN_TTL_DAYS', { infer: true }) * 86_400;
    this.webSuccessUrl = new URL(config.get('WEB_AUTH_SUCCESS_URL', { infer: true }));
  }

  @Get('google/start')
  @ApiOperation({ summary: 'Begin Google OpenID Connect authorization.' })
  async googleStart(
    @Query() query: GoogleStartQueryDto,
    @Res() reply: FastifyReply,
  ): Promise<void> {
    const url = await this.auth.beginGoogleAuthorization(query.redirectPath);
    await reply.redirect(url);
  }

  @Get('google/callback')
  @ApiOperation({ summary: 'Complete Google authorization and create a browser session.' })
  async googleCallback(
    @Query() query: GoogleCallbackQueryDto,
    @Req() request: FastifyRequest,
    @Res() reply: FastifyReply,
  ): Promise<void> {
    const completed = await this.auth.completeGoogleAuthorization(
      query.code,
      query.state,
      this.fingerprint(request),
    );
    this.setRefreshCookie(reply, completed.refreshToken);
    const redirect = new URL(this.webSuccessUrl);
    redirect.pathname = completed.redirectPath;
    redirect.search = '';
    await reply.redirect(redirect.toString());
  }

  @Post('refresh')
  @HttpCode(200)
  @UseGuards(CookieMutationGuard)
  @ApiOperation({ summary: 'Rotate the browser refresh session and return an access JWT.' })
  async refresh(@Req() request: FastifyRequest, @Res() reply: FastifyReply): Promise<void> {
    const refreshToken = request.cookies[this.cookieName];
    if (!refreshToken) {
      throw new UnauthorizedException('A refresh session cookie is required.');
    }
    const session = await this.auth.refresh(refreshToken, this.fingerprint(request));
    this.setRefreshCookie(reply, session.refreshToken);
    await reply.send({
      accessToken: session.accessToken,
      expiresInSeconds: session.expiresInSeconds,
      organization: session.organization,
      user: session.user,
    });
  }

  @Post('logout')
  @HttpCode(204)
  @UseGuards(CookieMutationGuard)
  @ApiOperation({ summary: 'Revoke the current refresh-session family.' })
  async logout(@Req() request: FastifyRequest, @Res() reply: FastifyReply): Promise<void> {
    await this.auth.logout(request.cookies[this.cookieName]);
    reply.clearCookie(this.cookieName, this.cookieOptions());
    await reply.send();
  }

  @Get('me')
  @UseGuards(AccessTokenGuard)
  @ApiBearerAuth()
  @ApiOperation({ summary: 'Return the authenticated user and active organization.' })
  me(@CurrentAuth() context: AccessContext) {
    return this.auth.me(context);
  }

  private setRefreshCookie(reply: FastifyReply, token: string): void {
    reply.setCookie(this.cookieName, token, {
      ...this.cookieOptions(),
      maxAge: this.refreshMaxAgeSeconds,
    });
  }

  private cookieOptions() {
    return {
      httpOnly: true,
      path: '/v1/auth',
      sameSite: 'lax' as const,
      secure: this.cookieSecure,
    };
  }

  private fingerprint(request: FastifyRequest) {
    return {
      ipAddress: request.ip,
      userAgent: request.headers['user-agent'],
    };
  }
}
