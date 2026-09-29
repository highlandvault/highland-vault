import { Controller, HttpCode, Param, Post, Req } from '@nestjs/common';
import { z } from 'zod';
import type { FastifyRequest } from 'fastify';
import { Errors } from '../common/errors';
import { ZodValidationPipe } from '../common/zod-validation.pipe';
import { Public } from '../rbac/access';
import { rawBodyOf } from './webhook-request';
import { WebhookIntakeService } from './webhook-intake.service';

/** A provider code is short and boring by nature; anything else is not one. */
const ProviderParam = new ZodValidationPipe(
  z.object({ provider: z.string().regex(/^[a-z][a-z0-9_]{1,31}$/) }),
);

/**
 * Provider webhooks (Revision 2 B10; ADR-0006; Phase 6 decisions D5 = B, D6 = C).
 *
 * Deliberately **not** market-scoped. A payment provider knows nothing about
 * Highland Vault's markets and cannot be asked to name one; the market comes
 * from the order the event turns out to be about.
 *
 * `@Public()` **without** `identify`: no session is looked up and no guest
 * cookie is resolved, so nothing a browser carries can influence this route
 * (invariant I13). Its authentication is the signature over the raw bytes, and
 * that is the only thing that matters here. See `webhook-request.ts` for why
 * the browser origin check does not apply and why that removes no protection.
 *
 * Responses are deliberately dull. A provider gets a status and an empty
 * acknowledgement; it has no use for our error vocabulary, and a caller
 * probing the endpoint learns nothing from the answer about whether a
 * reference exists, an event is known, or a signature was nearly right.
 */
@Controller('webhooks/payments')
export class WebhooksController {
  constructor(private readonly intake: WebhookIntakeService) {}

  @Post(':provider')
  @HttpCode(200)
  @Public()
  async receive(
    @Param(ProviderParam) params: { provider: string },
    @Req() request: FastifyRequest,
  ): Promise<{ received: true }> {
    const rawBody = rawBodyOf(request);
    if (!rawBody) {
      // The raw bytes are captured for exactly this route, so their absence
      // means the request never carried a body. Nothing to verify.
      throw Errors.badRequest('BAD_REQUEST', 'The request is malformed.');
    }
    await this.intake.receive(params.provider, rawBody, request.headers);
    // The same answer for a new event, a duplicate and one that needed nothing:
    // all three were received, and which it was is not the sender's business.
    return { received: true };
  }
}
