'use server';

import { AdminDrawResponseSchema } from '@hv/contracts';
import {
  MARKET_DEFINITIONS,
  MARKET_TIME_ZONES,
  MoneyError,
  TimeError,
  isMarketCode,
  parseDecimalMoney,
  zonedLocalToUtc,
} from '@hv/domain';
import { redirect } from 'next/navigation';
import { type ApiResult, apiFetch } from '@/lib/api';

/**
 * Draw management actions. They only translate form input into API calls:
 * typed decimals become integer minor units and market wall-clock times become
 * UTC (both via @hv/domain). Every rule is enforced by the API.
 */

const text = (form: FormData, name: string) => {
  const value = form.get(name);
  return typeof value === 'string' ? value.trim() : '';
};

function marketOrThrow(market: string) {
  if (!isMarketCode(market)) throw new Error('unknown market');
  return market;
}

function back(path: string, message: string): never {
  redirect(`${path}${path.includes('?') ? '&' : '?'}error=${encodeURIComponent(message)}`);
}

function describe(result: Extract<ApiResult<unknown>, { ok: false }>): string {
  const issues = (result.details as { issues?: { path: string; message: string }[] } | undefined)
    ?.issues;
  const blockers = (result.details as { blockers?: string[] } | undefined)?.blockers;
  if (issues?.length) return issues.map((i) => `${i.path || 'input'}: ${i.message}`).join('; ');
  if (blockers?.length) return `${result.message} (${blockers.join(', ')})`;
  return result.message;
}

function configFrom(form: FormData, market: string, returnTo: string) {
  const code = marketOrThrow(market);
  const zone = MARKET_TIME_ZONES[code];
  try {
    return {
      slug: text(form, 'slug'),
      title: text(form, 'title'),
      description: text(form, 'description'),
      ticketPriceMinor: parseDecimalMoney(text(form, 'price'), MARKET_DEFINITIONS[code].currency)
        .amountMinor,
      totalTickets: Number(text(form, 'totalTickets')),
      maxPerPerson: Number(text(form, 'maxPerPerson')),
      winnerPositions: Number(text(form, 'winnerPositions')),
      opensAt: zonedLocalToUtc(text(form, 'opensAt'), zone).toISOString(),
      closesAt: zonedLocalToUtc(text(form, 'closesAt'), zone).toISOString(),
    };
  } catch (error) {
    if (error instanceof MoneyError || error instanceof TimeError) back(returnTo, error.message);
    throw error;
  }
}

export async function createDraw(market: string, form: FormData): Promise<void> {
  const returnTo = `/admin/draws/${market}/new`;
  const result = await apiFetch(`/admin/markets/${market}/draws`, {
    method: 'POST',
    body: configFrom(form, market, returnTo),
    parse: (json) => AdminDrawResponseSchema.parse(json).draw,
  });
  if (!result.ok) back(returnTo, describe(result));
  redirect(`/admin/draws/${market}/${result.data.id}?saved=created`);
}

export async function updateDraw(market: string, id: string, form: FormData): Promise<void> {
  const path = `/admin/draws/${market}/${id}`;
  const result = await apiFetch(`/admin/markets/${market}/draws/${id}`, {
    method: 'PUT',
    body: configFrom(form, market, path),
  });
  if (!result.ok) back(path, describe(result));
  redirect(`${path}?saved=details`);
}

export async function savePrizes(market: string, id: string, form: FormData): Promise<void> {
  const path = `/admin/draws/${market}/${id}`;
  const positions = Number(text(form, 'winnerPositions'));
  const prizes = Array.from({ length: positions }, (_, i) => i + 1)
    .map((position) => ({
      position,
      title: text(form, `prize-${position}-title`),
      description: text(form, `prize-${position}-description`),
    }))
    .filter((p) => p.title.length > 0);
  const result = await apiFetch(`/admin/markets/${market}/draws/${id}/prizes`, {
    method: 'PUT',
    body: { prizes },
  });
  if (!result.ok) back(path, describe(result));
  redirect(`${path}?saved=prizes`);
}

export async function saveSkillQuestion(market: string, id: string, form: FormData): Promise<void> {
  const path = `/admin/draws/${market}/${id}`;
  const correct = text(form, 'correct');
  const options = [1, 2, 3, 4]
    .map((n) => ({ n, label: text(form, `option-${n}`) }))
    .filter((o) => o.label.length > 0)
    .map((o) => ({ label: o.label, isCorrect: String(o.n) === correct }));
  const result = await apiFetch(`/admin/markets/${market}/draws/${id}/skill-question`, {
    method: 'PUT',
    body: { prompt: text(form, 'prompt'), options },
  });
  if (!result.ok) back(path, describe(result));
  redirect(`${path}?saved=question`);
}

export async function publishDraw(market: string, id: string, form: FormData): Promise<void> {
  const path = `/admin/draws/${market}/${id}`;
  const reason = text(form, 'reason');
  const result = await apiFetch(`/admin/markets/${market}/draws/${id}/publish`, {
    method: 'POST',
    body: reason ? { reason } : {},
  });
  if (!result.ok) back(path, describe(result));
  redirect(`${path}?saved=published`);
}

export async function cancelDraw(market: string, id: string, form: FormData): Promise<void> {
  const path = `/admin/draws/${market}/${id}`;
  const result = await apiFetch(`/admin/markets/${market}/draws/${id}/cancel`, {
    method: 'POST',
    body: { reason: text(form, 'reason') },
  });
  if (!result.ok) back(path, describe(result));
  redirect(`${path}?saved=cancelled`);
}
