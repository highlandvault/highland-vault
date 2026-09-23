import 'server-only';
import {
  DrawListResponseSchema,
  DrawResponseSchema,
  type PublicDrawDetail,
  type PublicDrawSummary,
} from '@hv/contracts';
import { apiFetch } from './api';

/**
 * Customer draw data, always from the API: the API applies the market gate and
 * the publication rules, so nothing here can show a draft, a cancelled draw,
 * another market's draw, or anything in a disabled market.
 */

export type DrawsResult = { ok: true; draws: PublicDrawSummary[] } | { ok: false; reason: string };

export async function fetchDraws(market: string): Promise<DrawsResult> {
  const result = await apiFetch(`/markets/${market}/draws`, {
    parse: (json) => DrawListResponseSchema.parse(json).draws,
  });
  return result.ok ? { ok: true, draws: result.data } : { ok: false, reason: result.code };
}

/** The draw, or null when the API does not serve it (→ 404). Other failures throw (→ error page). */
export async function fetchDraw(market: string, slug: string): Promise<PublicDrawDetail | null> {
  if (!/^[a-z0-9]+(-[a-z0-9]+)*$/.test(slug) || slug.length > 80) return null;
  const result = await apiFetch(`/markets/${market}/draws/${slug}`, {
    parse: (json) => DrawResponseSchema.parse(json).draw,
  });
  if (result.ok) return result.data;
  if (result.status === 404) return null;
  throw new Error(`Draw lookup failed: ${result.code}`);
}
