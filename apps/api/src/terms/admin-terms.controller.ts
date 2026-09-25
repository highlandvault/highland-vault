import { Body, Controller, Get, HttpCode, Param, Post } from '@nestjs/common';
import {
  type AdminTermsListResponse,
  type AdminTermsVersionResponse,
  CreateTermsVersionRequestSchema,
  type CreateTermsVersionRequest,
  MarketParamSchema,
  TermsVersionActionRequestSchema,
  type TermsVersionActionRequest,
  TermsVersionIdParamSchema,
} from '@hv/contracts';
import { type AuthContext, CurrentAuth, Meta, type RequestMeta } from '../common/request-context';
import { ZodValidationPipe } from '../common/zod-validation.pipe';
import { RequirePermission } from '../rbac/access';
import { AdminTermsService } from './admin-terms.service';

const MarketParam = new ZodValidationPipe(MarketParamSchema);
const TermsParam = new ZodValidationPipe(TermsVersionIdParamSchema);

/**
 * Publishing a market's terms.
 *
 * Terms are a market setting, so they carry the same permission and the same
 * step-up requirement as the rest of them (`markets.gate.manage`, scoped to
 * the market in the route, sensitive). Which market is being changed comes
 * from the route and is checked by the RBAC scope; the body never names one.
 */
const TermsChange = () =>
  RequirePermission('markets.gate.manage', { scope: { param: 'market' }, sensitive: true });

@Controller('admin/markets/:market/terms')
export class AdminTermsController {
  constructor(private readonly service: AdminTermsService) {}

  @Get()
  @RequirePermission('markets.gate.manage', { scope: { param: 'market' } })
  async list(@Param(MarketParam) params: { market: string }): Promise<AdminTermsListResponse> {
    return { versions: await this.service.list(params.market) };
  }

  @Post()
  @HttpCode(201)
  @TermsChange()
  async create(
    @Param(MarketParam) params: { market: string },
    @Body(new ZodValidationPipe(CreateTermsVersionRequestSchema)) body: CreateTermsVersionRequest,
    @CurrentAuth() auth: AuthContext,
    @Meta() meta: RequestMeta,
  ): Promise<AdminTermsVersionResponse> {
    return { version: await this.service.create(params.market, body, auth, meta) };
  }

  @Post(':terms/publish')
  @HttpCode(200)
  @TermsChange()
  async publish(
    @Param(TermsParam) params: { market: string; terms: string },
    @Body(new ZodValidationPipe(TermsVersionActionRequestSchema)) body: TermsVersionActionRequest,
    @CurrentAuth() auth: AuthContext,
    @Meta() meta: RequestMeta,
  ): Promise<AdminTermsVersionResponse> {
    return {
      version: await this.service.publish(params.market, params.terms, body.reason, auth, meta),
    };
  }

  @Post(':terms/activate')
  @HttpCode(200)
  @TermsChange()
  async activate(
    @Param(TermsParam) params: { market: string; terms: string },
    @Body(new ZodValidationPipe(TermsVersionActionRequestSchema)) body: TermsVersionActionRequest,
    @CurrentAuth() auth: AuthContext,
    @Meta() meta: RequestMeta,
  ): Promise<AdminTermsVersionResponse> {
    return {
      version: await this.service.activate(params.market, params.terms, body.reason, auth, meta),
    };
  }
}
