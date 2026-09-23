import { Body, Controller, Get, HttpCode, Param, Post, Put } from '@nestjs/common';
import {
  type AdminMarketListResponse,
  type AdminMarketResponse,
  type MarketGateChangeRequest,
  MarketGateChangeRequestSchema,
  MarketParamSchema,
  type RecordLegalApprovalRequest,
  RecordLegalApprovalRequestSchema,
  type UpdateMarketSettingsRequest,
  UpdateMarketSettingsRequestSchema,
} from '@hv/contracts';
import { type AuthContext, CurrentAuth, Meta, type RequestMeta } from '../common/request-context';
import { ZodValidationPipe } from '../common/zod-validation.pipe';
import { RequirePermission } from '../rbac/access';
import { AdminMarketsService } from './admin-markets.service';

const MarketParam = new ZodValidationPipe(MarketParamSchema);

/** Market gate management. Every mutation is a sensitive operation (see AdminMarketsService). */
const GateChange = () =>
  RequirePermission('markets.gate.manage', { scope: { param: 'market' }, sensitive: true });

@Controller('admin/markets')
export class AdminMarketsController {
  constructor(private readonly service: AdminMarketsService) {}

  @Get()
  @RequirePermission('admin.access', { scope: 'any' })
  async list(): Promise<AdminMarketListResponse> {
    return { markets: await this.service.list() };
  }

  @Put(':market/settings')
  @GateChange()
  async updateSettings(
    @Param(MarketParam) params: { market: string },
    @Body(new ZodValidationPipe(UpdateMarketSettingsRequestSchema))
    body: UpdateMarketSettingsRequest,
    @CurrentAuth() auth: AuthContext,
    @Meta() meta: RequestMeta,
  ): Promise<AdminMarketResponse> {
    return { market: await this.service.updateSettings(params.market, body, auth, meta) };
  }

  @Post(':market/legal-approval')
  @HttpCode(200)
  @GateChange()
  async recordLegalApproval(
    @Param(MarketParam) params: { market: string },
    @Body(new ZodValidationPipe(RecordLegalApprovalRequestSchema)) body: RecordLegalApprovalRequest,
    @CurrentAuth() auth: AuthContext,
    @Meta() meta: RequestMeta,
  ): Promise<AdminMarketResponse> {
    return { market: await this.service.recordLegalApproval(params.market, body, auth, meta) };
  }

  @Post(':market/enable')
  @HttpCode(200)
  @GateChange()
  async enable(
    @Param(MarketParam) params: { market: string },
    @Body(new ZodValidationPipe(MarketGateChangeRequestSchema)) body: MarketGateChangeRequest,
    @CurrentAuth() auth: AuthContext,
    @Meta() meta: RequestMeta,
  ): Promise<AdminMarketResponse> {
    return { market: await this.service.enable(params.market, body, auth, meta) };
  }

  @Post(':market/disable')
  @HttpCode(200)
  @GateChange()
  async disable(
    @Param(MarketParam) params: { market: string },
    @Body(new ZodValidationPipe(MarketGateChangeRequestSchema)) body: MarketGateChangeRequest,
    @CurrentAuth() auth: AuthContext,
    @Meta() meta: RequestMeta,
  ): Promise<AdminMarketResponse> {
    return { market: await this.service.disable(params.market, body, auth, meta) };
  }
}
