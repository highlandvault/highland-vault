import { Body, Controller, Get, Param, Put } from '@nestjs/common';
import {
  MarketParamSchema,
  UpdatePaymentConfigRequestSchema,
  type AdminPaymentConfigResponse,
  type UpdatePaymentConfigRequest,
} from '@hv/contracts';
import { type AuthContext, CurrentAuth, Meta, type RequestMeta } from '../common/request-context';
import { ZodValidationPipe } from '../common/zod-validation.pipe';
import { RequirePermission } from '../rbac/access';
import { AdminPaymentConfigService } from './admin-payment-config.service';

const MarketParam = new ZodValidationPipe(MarketParamSchema);

/**
 * Per-market payment configuration for staff (B10; D17 = A; P6-7).
 *
 * **Both routes require `config.manage`**, which `0006_rbac.sql` grants to
 * `super_admin` and to nobody else — so D17's "super-admin only" is a property
 * of the permission matrix rather than a role-name check here, and stays true
 * if the matrix ever changes.
 *
 * Reading is behind the same permission as writing, which is unlike the payment
 * views next door (`orders.read`). Deliberate: this says which provider a market
 * settles through and under which credential reference — commercial
 * configuration, not part of the story of an order — so it belongs with whoever
 * may change it, not with everyone who may read an order.
 *
 * The write is **sensitive**, so the access guard additionally demands step-up
 * MFA inside `STEP_UP_WINDOW_MS`, and it carries a reason that reaches the
 * audit log. No customer route exposes any of this.
 */
@Controller('admin/markets/:market/payment-config')
export class AdminPaymentConfigController {
  constructor(private readonly configs: AdminPaymentConfigService) {}

  @Get()
  @RequirePermission('config.manage', { scope: { param: 'market' } })
  async get(@Param(MarketParam) params: { market: string }): Promise<AdminPaymentConfigResponse> {
    return { config: await this.configs.get(params.market) };
  }

  @Put()
  @RequirePermission('config.manage', { scope: { param: 'market' }, sensitive: true })
  async update(
    @Param(MarketParam) params: { market: string },
    @Body(new ZodValidationPipe(UpdatePaymentConfigRequestSchema)) body: UpdatePaymentConfigRequest,
    @CurrentAuth() auth: AuthContext,
    @Meta() meta: RequestMeta,
  ): Promise<AdminPaymentConfigResponse> {
    return { config: await this.configs.update(params.market, body, auth, meta) };
  }
}
