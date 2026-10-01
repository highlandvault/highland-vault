import { isMarketCode } from '@hv/domain';
import { NextResponse, type NextRequest } from 'next/server';
import { ORDER_ID } from '@/lib/checkout';
import { fetchPaymentStatus } from '@/lib/payments';

/**
 * What the pending payment page polls (UI-6).
 *
 * ## Why this exists at all
 *
 * The browser never talks to the API (ADR-0009): the session token lives in the
 * web server's own cookie and there is no CORS on the API. So a client
 * component that wants to know whether a payment resolved has to ask the web
 * server, and this is the web server asking the API on its behalf — with the
 * session it already holds, over the read-only status route.
 *
 * ## What it cannot do
 *
 * It is a GET, it forwards a GET, and the route it forwards to was made
 * genuinely read-only by ADR-0035. Nothing on this path reconciles, finalises,
 * contacts a provider or writes a row. Polling it a thousand times changes
 * nothing, which is exactly the property that makes polling safe to offer.
 *
 * ## What it answers with
 *
 * The two statuses and the server's clock, and nothing else. No provider
 * reference, no amounts, no error detail — a poller needs to know whether to
 * stop, not how the payment system is built. Anything it may not see is the
 * same `null` answer: somebody else's order, a lapsed guest verification, a
 * rate limit. The page it belongs to is already rendered and already correct,
 * so an unusable answer here costs the customer nothing.
 *
 * The identifiers come from the query rather than being rediscovered here: the
 * page that renders the poller has already read them from the API, and neither
 * is a secret — the order id is in the address of the customer's own order
 * page. They are still checked for shape, so nothing malformed is forwarded.
 */
export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
): Promise<NextResponse> {
  const { id } = await params;
  const market = request.nextUrl.searchParams.get('market') ?? '';
  const orderId = request.nextUrl.searchParams.get('order') ?? '';

  // One answer for every unusable request, so this route reveals nothing about
  // which orders or attempts exist.
  const unknown = () => NextResponse.json({ status: null }, { status: 404 });
  if (!isMarketCode(market) || !ORDER_ID.test(orderId) || !ORDER_ID.test(id)) return unknown();

  const payment = await fetchPaymentStatus(market, orderId, id);
  if (!payment) return unknown();

  return NextResponse.json(
    {
      // The field the customer's wording is keyed on, here and on the page.
      order: payment.order.status,
      attempt: payment.status,
      serverTime: payment.serverTime,
    },
    // Never cached: the whole point is that the answer changes.
    { status: 200, headers: { 'cache-control': 'no-store' } },
  );
}
