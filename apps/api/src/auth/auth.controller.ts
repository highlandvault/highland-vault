import { Body, Controller, Get, HttpCode, Post, Res } from '@nestjs/common';
import {
  type LoginRequest,
  LoginRequestSchema,
  type LoginResponse,
  type MeResponse,
  type MfaVerifyRequest,
  MfaVerifyRequestSchema,
  type RegisterRequest,
  RegisterRequestSchema,
  type TotpConfirmRequest,
  TotpConfirmRequestSchema,
  type TotpConfirmResponse,
  type TotpSetupResponse,
} from '@hv/contracts';
import type { FastifyReply } from 'fastify';
import { type AuthContext, CurrentAuth, Meta, type RequestMeta } from '../common/request-context';
import { ZodValidationPipe } from '../common/zod-validation.pipe';
import { Authenticated, Public } from '../rbac/access';
import { AuthService, type SignInResult } from './auth.service';
import { clearedSessionCookie, sessionCookie } from './cookies';
import { MfaService } from './mfa.service';
import { SessionsService } from './sessions.service';

@Controller('auth')
export class AuthController {
  constructor(
    private readonly auth: AuthService,
    private readonly mfa: MfaService,
    private readonly sessions: SessionsService,
  ) {}

  @Post('register')
  @HttpCode(201)
  @Public()
  async register(
    @Body(new ZodValidationPipe(RegisterRequestSchema)) body: RegisterRequest,
    @Meta() meta: RequestMeta,
    @Res({ passthrough: true }) reply: FastifyReply,
  ): Promise<LoginResponse> {
    return this.signedIn(reply, await this.auth.register(body, meta));
  }

  @Post('login')
  @HttpCode(200)
  @Public()
  async login(
    @Body(new ZodValidationPipe(LoginRequestSchema)) body: LoginRequest,
    @Meta() meta: RequestMeta,
    @Res({ passthrough: true }) reply: FastifyReply,
  ): Promise<LoginResponse> {
    return this.signedIn(reply, await this.auth.login(body, meta));
  }

  @Post('logout')
  @HttpCode(204)
  @Authenticated({ allowMfaPending: true })
  async logout(
    @CurrentAuth() auth: AuthContext,
    @Res({ passthrough: true }) reply: FastifyReply,
  ): Promise<void> {
    await this.auth.logout(auth);
    void reply.header('set-cookie', clearedSessionCookie(this.sessions.cookieOptions));
  }

  @Get('me')
  @Authenticated()
  me(@CurrentAuth() auth: AuthContext): Promise<MeResponse> {
    return this.auth.me(auth);
  }

  /** Second factor at sign-in, and step-up before sensitive operations. */
  @Post('mfa/verify')
  @HttpCode(200)
  @Authenticated({ allowMfaPending: true })
  async verifyMfa(
    @Body(new ZodValidationPipe(MfaVerifyRequestSchema)) body: MfaVerifyRequest,
    @CurrentAuth() auth: AuthContext,
    @Meta() meta: RequestMeta,
  ): Promise<LoginResponse> {
    await this.mfa.verify(auth, body, meta);
    return { status: 'authenticated' };
  }

  @Post('mfa/totp/setup')
  @HttpCode(200)
  @Authenticated()
  setupTotp(@CurrentAuth() auth: AuthContext): Promise<TotpSetupResponse> {
    return this.mfa.setup(auth);
  }

  @Post('mfa/totp/confirm')
  @HttpCode(200)
  @Authenticated()
  confirmTotp(
    @Body(new ZodValidationPipe(TotpConfirmRequestSchema)) body: TotpConfirmRequest,
    @CurrentAuth() auth: AuthContext,
    @Meta() meta: RequestMeta,
  ): Promise<TotpConfirmResponse> {
    return this.mfa.confirm(auth, body.code, meta);
  }

  private signedIn(reply: FastifyReply, result: SignInResult): LoginResponse {
    void reply.header(
      'set-cookie',
      sessionCookie(result.session.token, result.session.expiresAt, this.sessions.cookieOptions),
    );
    return { status: result.status };
  }
}
