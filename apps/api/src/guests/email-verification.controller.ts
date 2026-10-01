import { Body, Controller, Get, HttpCode, Post, Query, Res, UseGuards } from '@nestjs/common';
import {
  type GuestVerificationResponse,
  RequestVerificationCodeRequestSchema,
  type RequestVerificationCodeRequest,
  type VerificationCodeSentResponse,
  VerifyEmailRequestSchema,
  type VerifyEmailRequest,
} from '@hv/contracts';
import type { FastifyReply } from 'fastify';
import { z } from 'zod';
import { guestSessionCookie } from '../auth/cookies';
import { CurrentGuest, Meta, type RequestMeta } from '../common/request-context';
import { ZodValidationPipe } from '../common/zod-validation.pipe';
import { MarketGuard } from '../markets/market.guard';
import { Public } from '../rbac/access';
import { EmailVerificationService } from './email-verification.service';
import type { GuestContext } from './guest-sessions.repository';
import { GuestSessionsService } from './guest-sessions.service';

const NoQuery = new ZodValidationPipe(z.strictObject({}));

/**
 * Guest email verification during checkout (ADR-0020).
 *
 * Public, because the whole point is that the caller has no account — but
 * `identify: true`, so a guest cookie is resolved if there is one. A guest
 * session is created on the first code request, which is why these are the
 * only routes that set the guest cookie.
 */
@Controller('markets/:market/checkout/email')
@UseGuards(MarketGuard)
export class EmailVerificationController {
  constructor(
    private readonly verification: EmailVerificationService,
    private readonly guests: GuestSessionsService,
  ) {}

  @Post('code')
  @HttpCode(202)
  @Public({ identify: true })
  async requestCode(
    @Body(new ZodValidationPipe(RequestVerificationCodeRequestSchema))
    body: RequestVerificationCodeRequest,
    @CurrentGuest() guest: GuestContext | null,
    @Meta() meta: RequestMeta,
    @Res({ passthrough: true }) reply: FastifyReply,
  ): Promise<VerificationCodeSentResponse> {
    const result = await this.verification.requestCode(guest, body.email, meta);
    if (result.issued) {
      void reply.header(
        'set-cookie',
        guestSessionCookie(result.issued.token, result.issued.expiresAt, this.guests.cookieOptions),
      );
    }
    return result.response;
  }

  @Post('verify')
  @HttpCode(200)
  @Public({ identify: true })
  async verify(
    @Body(new ZodValidationPipe(VerifyEmailRequestSchema)) body: VerifyEmailRequest,
    @CurrentGuest() guest: GuestContext | null,
  ): Promise<GuestVerificationResponse> {
    await this.verification.verify(guest, body.email, body.code);
    // Re-read, so the response reflects what was actually stored.
    const updated = guest ? await this.guests.reload(guest.guestSessionId) : null;
    return { verification: this.verification.verificationState(updated) };
  }

  @Get('verification')
  @Public({ identify: true })
  verification_(
    @Query(NoQuery) _query: object,
    @CurrentGuest() guest: GuestContext | null,
  ): GuestVerificationResponse {
    return { verification: this.verification.verificationState(guest) };
  }
}
