import { Body, Controller, Get, HttpCode, Param, Post, Put } from '@nestjs/common';
import {
  type AdminDrawListResponse,
  type AdminDrawResponse,
  type CancelDrawRequest,
  CancelDrawRequestSchema,
  type DrawConfigRequest,
  DrawConfigRequestSchema,
  DrawIdParamSchema,
  MarketParamSchema,
  type PublishDrawRequest,
  PublishDrawRequestSchema,
  type ReplacePrizesRequest,
  ReplacePrizesRequestSchema,
  type SkillQuestionRequest,
  SkillQuestionRequestSchema,
} from '@hv/contracts';
import { type AuthContext, CurrentAuth, Meta, type RequestMeta } from '../common/request-context';
import { ZodValidationPipe } from '../common/zod-validation.pipe';
import { RequirePermission } from '../rbac/access';
import { AdminDrawsService } from './admin-draws.service';

type DrawParams = { market: string; draw: string };

const MarketParam = new ZodValidationPipe(MarketParamSchema);
const DrawParam = new ZodValidationPipe(DrawIdParamSchema);

/** Any staff member with access to this market may read its draws (drafts included). */
const ReadDraws = () => RequirePermission('admin.access', { scope: { param: 'market' } });
/** Changing a market's draws needs `draws.write` for that market (admin, super_admin). */
const WriteDraws = () => RequirePermission('draws.write', { scope: { param: 'market' } });

@Controller('admin/markets/:market/draws')
export class AdminDrawsController {
  constructor(private readonly service: AdminDrawsService) {}

  @Get()
  @ReadDraws()
  async list(@Param(MarketParam) params: { market: string }): Promise<AdminDrawListResponse> {
    return { draws: await this.service.list(params.market) };
  }

  @Get(':draw')
  @ReadDraws()
  async get(@Param(DrawParam) params: DrawParams): Promise<AdminDrawResponse> {
    return { draw: await this.service.get(params.market, params.draw) };
  }

  @Post()
  @HttpCode(201)
  @WriteDraws()
  async create(
    @Param(MarketParam) params: { market: string },
    @Body(new ZodValidationPipe(DrawConfigRequestSchema)) body: DrawConfigRequest,
    @CurrentAuth() auth: AuthContext,
    @Meta() meta: RequestMeta,
  ): Promise<AdminDrawResponse> {
    return { draw: await this.service.create(params.market, body, auth, meta) };
  }

  @Put(':draw')
  @WriteDraws()
  async update(
    @Param(DrawParam) params: DrawParams,
    @Body(new ZodValidationPipe(DrawConfigRequestSchema)) body: DrawConfigRequest,
    @CurrentAuth() auth: AuthContext,
    @Meta() meta: RequestMeta,
  ): Promise<AdminDrawResponse> {
    return { draw: await this.service.update(params.market, params.draw, body, auth, meta) };
  }

  @Put(':draw/prizes')
  @WriteDraws()
  async replacePrizes(
    @Param(DrawParam) params: DrawParams,
    @Body(new ZodValidationPipe(ReplacePrizesRequestSchema)) body: ReplacePrizesRequest,
    @CurrentAuth() auth: AuthContext,
    @Meta() meta: RequestMeta,
  ): Promise<AdminDrawResponse> {
    return {
      draw: await this.service.replacePrizes(params.market, params.draw, body, auth, meta),
    };
  }

  @Put(':draw/skill-question')
  @WriteDraws()
  async setSkillQuestion(
    @Param(DrawParam) params: DrawParams,
    @Body(new ZodValidationPipe(SkillQuestionRequestSchema)) body: SkillQuestionRequest,
    @CurrentAuth() auth: AuthContext,
    @Meta() meta: RequestMeta,
  ): Promise<AdminDrawResponse> {
    return {
      draw: await this.service.setSkillQuestion(params.market, params.draw, body, auth, meta),
    };
  }

  @Post(':draw/publish')
  @HttpCode(200)
  @WriteDraws()
  async publish(
    @Param(DrawParam) params: DrawParams,
    @Body(new ZodValidationPipe(PublishDrawRequestSchema)) body: PublishDrawRequest,
    @CurrentAuth() auth: AuthContext,
    @Meta() meta: RequestMeta,
  ): Promise<AdminDrawResponse> {
    return { draw: await this.service.publish(params.market, params.draw, body, auth, meta) };
  }

  @Post(':draw/cancel')
  @HttpCode(200)
  @WriteDraws()
  async cancel(
    @Param(DrawParam) params: DrawParams,
    @Body(new ZodValidationPipe(CancelDrawRequestSchema)) body: CancelDrawRequest,
    @CurrentAuth() auth: AuthContext,
    @Meta() meta: RequestMeta,
  ): Promise<AdminDrawResponse> {
    return { draw: await this.service.cancel(params.market, params.draw, body, auth, meta) };
  }
}
