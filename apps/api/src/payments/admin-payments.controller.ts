import { Body, Controller, Get, HttpCode, Param, Post } from '@nestjs/common';
import {
  AdminOpenPayloadRequestSchema,
  AdminReconcileRequestSchema,
  AdminRefundDuplicateRequestSchema,
  type AdminOpenPayloadRequest,
  type AdminOpenPayloadResponse,
  type AdminOrderPaymentsResponse,
  type AdminReconcileRequest,
  type AdminReconcileResponse,
  type AdminRefundDuplicateRequest,
  type AdminRefundDuplicateResponse,
} from '@hv/contracts';
import { z } from 'zod';
import { type AuthContext, CurrentAuth, Meta, type RequestMeta } from '../common/request-context';
import { ZodValidationPipe } from '../common/zod-validation.pipe';
import { RequirePermission } from '../rbac/access';
import { AdminPaymentsService } from './admin-payments.service';

const OrderPath = new ZodValidationPipe(z.object({ market: z.string(), order: z.uuid() }));
const PaymentPath = new ZodValidationPipe(
  z.object({ market: z.string(), order: z.uuid(), payment: z.uuid() }),
);
const EventPath = new ZodValidationPipe(
  z.object({ market: z.string(), order: z.uuid(), event: z.uuid() }),
);

/**
 * Staff payment operations (D13a, OD-5, OD-7a).
 *
 * **Two authorities, deliberately unequal.** Reading is `orders.read`, which
 * 0006 already grants to all five staff roles: a payment is part of the story
 * of an order, and whoever may read the order may read how it was paid for.
 *
 * Everything else is `payments.reconcile` (0025) and **sensitive**, so the
 * access guard demands step-up MFA inside `STEP_UP_WINDOW_MS`. These three
 * actions move money, reveal a customer's provider data, or both, and every one
 * of them is audited with the operator's reason.
 *
 * `payments.reconcile` is market-scoped, so a grant limited to one market does
 * not reach another market's orders — and the service proves the order belongs
 * to the market besides, because a scope check and a relationship check answer
 * different questions.
 */
const Reconcile = () =>
  RequirePermission('payments.reconcile', { scope: { param: 'market' }, sensitive: true });

@Controller('admin/markets/:market/orders/:order')
export class AdminPaymentsController {
  constructor(private readonly payments: AdminPaymentsService) {}

  /** Normalised attempts, deliveries and refunds. Never a payload or a reference. */
  @Get('payments')
  @RequirePermission('orders.read', { scope: { param: 'market' } })
  async view(
    @Param(OrderPath) params: { market: string; order: string },
  ): Promise<AdminOrderPaymentsResponse> {
    return this.payments.view(params.market, params.order);
  }

  /**
   * Ask the provider now, rather than waiting for the reconciler's next tick.
   *
   * OD-5's second invoker. It reaches the same `confirm` as everything else, so
   * an operator cannot produce an outcome the rules would not have produced.
   */
  @Post('payments/:payment/reconcile')
  @HttpCode(200)
  @Reconcile()
  async reconcile(
    @Param(PaymentPath) params: { market: string; order: string; payment: string },
    @Body(new ZodValidationPipe(AdminReconcileRequestSchema)) body: AdminReconcileRequest,
    @CurrentAuth() auth: AuthContext,
    @Meta() meta: RequestMeta,
  ): Promise<AdminReconcileResponse> {
    return this.payments.reconcilePayment(
      params.market,
      params.order,
      params.payment,
      body.reason,
      auth,
      meta,
    );
  }

  /**
   * Open one sealed provider payload (ADR-0033).
   *
   * A POST although it returns data, because it is an action with a reason and
   * an audit row, not a resource anyone may fetch. Nothing else in the system
   * returns this, and nothing logs it.
   */
  @Post('payment-events/:event/payload')
  @HttpCode(200)
  @Reconcile()
  async openPayload(
    @Param(EventPath) params: { market: string; order: string; event: string },
    @Body(new ZodValidationPipe(AdminOpenPayloadRequestSchema)) body: AdminOpenPayloadRequest,
    @CurrentAuth() auth: AuthContext,
    @Meta() meta: RequestMeta,
  ): Promise<AdminOpenPayloadResponse> {
    return this.payments.openEventPayload(
      params.market,
      params.order,
      params.event,
      body.reason,
      auth,
      meta,
    );
  }

  /**
   * Refund a capture the provider made twice (D22.3).
   *
   * The only way this runs. Webhook intake never triggers it and the reconciler
   * never triggers it, because deciding that a flagged capture is genuinely a
   * second one is a judgement, not a rule.
   */
  @Post('payment-events/:event/refund-duplicate')
  @HttpCode(200)
  @Reconcile()
  async refundDuplicate(
    @Param(EventPath) params: { market: string; order: string; event: string },
    @Body(new ZodValidationPipe(AdminRefundDuplicateRequestSchema))
    body: AdminRefundDuplicateRequest,
    @CurrentAuth() auth: AuthContext,
    @Meta() meta: RequestMeta,
  ): Promise<AdminRefundDuplicateResponse> {
    return this.payments.refundDuplicate(
      params.market,
      params.order,
      params.event,
      body.reason,
      auth,
      meta,
    );
  }
}
