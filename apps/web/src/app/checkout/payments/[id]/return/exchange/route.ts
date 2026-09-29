import { NextResponse, type NextRequest } from 'next/server';
import { ACCESS_COOKIE, ACCESS_COOKIE_MAX_AGE, ACCESS_COOKIE_PATH } from '@/lib/order-access';

/**
 * Taking the return link out of the URL (P6-8; OD-2; **D18 = B**).
 *
 * The provider is given this address before the customer leaves, so the token
 * has to arrive in a query string — there is nowhere else to put it. A bearer
 * credential in a URL ends up in browser history, in referrers and in any log
 * that records request lines, so the first thing that happens on the way back
 * is that it moves into an HttpOnly cookie and the URL is replaced.
 *
 * ## Why this is a Route Handler and not the page
 *
 * A Server Component renders **after** the response headers are committed, so
 * Next.js refuses `cookies().set()` there — and rightly: there is no response
 * left to put a header on. Setting the cookie is composing a response, which
 * is what a Route Handler is for. The page next door is now purely a reader.
 *
 * ## What it does not do
 *
 * It does not validate the token, because it cannot: only the API knows which
 * tokens exist, and asking it here would mean either a second round trip or a
 * second answer for the same question. An invalid token is written to the
 * cookie and then refused by the API on the very next request, which is the
 * same refusal a caller would get in any case. Nothing is disclosed by that:
 * the token is the caller's own, and the answer is identical for a forged
 * token, an expired one and one that never existed.
 *
 * It mutates no order, starts no payment, reaches no internal route, and never
 * writes the plaintext anywhere but the cookie it exists to set.
 */
function overHttps(request: NextRequest): boolean {
  const forwarded = request.headers.get('x-forwarded-proto');
  if (forwarded) return forwarded.split(',')[0]?.trim().toLowerCase() === 'https';
  return request.nextUrl.protocol === 'https:';
}

export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
): Promise<NextResponse> {
  const { id } = await params;
  const token = request.nextUrl.searchParams.get('t');

  // The clean address, which is where the customer ends up either way. It
  // carries no token, so it is safe in history and in a referrer.
  //
  // **Relative, deliberately.** `NextResponse.redirect` wants an absolute URL,
  // and the origin it would be built from is not the one the browser used:
  // `request.nextUrl.origin` normalises to `localhost` while the browser is on
  // `127.0.0.1`. Those are different hosts to a cookie, so the redirect landed
  // on an origin the cookie below had never been written for and the page found
  // nothing. A relative Location is resolved by the browser against the address
  // it actually asked for, which is the only origin that can be correct — and
  // it takes nothing on trust from a Host header.
  // Encoded so the id can only ever be one path segment: the Location always
  // starts `/checkout/` and so is always this origin, whatever the URL held.
  const clean = `/checkout/payments/${encodeURIComponent(id)}/return`;
  const redirect = () => new NextResponse(null, { status: 303, headers: { location: clean } });

  if (!token) {
    // Nothing to exchange. The page will find no cookie and answer exactly as
    // it does for any other caller without one — a 404, and no hint that this
    // address means anything.
    return redirect();
  }

  const response = redirect();
  response.cookies.set(ACCESS_COOKIE, token, {
    // Never readable by page JavaScript. The token is a bearer credential and
    // nothing in the browser has any business holding it.
    httpOnly: true,
    sameSite: 'lax',
    // Secure whenever the page itself was served over TLS, which is the same
    // condition the browser enforces. NODE_ENV is the wrong signal: `next
    // start` sets it to production even on a plain-HTTP origin, and the
    // browser then drops the cookie — the mechanism would silently not work.
    // Behind a TLS-terminating proxy the forwarded scheme is authoritative.
    secure: overHttps(request),
    // Scoped to the return pages, so it is not attached to every request the
    // customer makes for the rest of their visit.
    path: ACCESS_COOKIE_PATH,
    // The API decides the real lifetime (D19a: the order's deadline plus its
    // own configured tail). This only stops the browser keeping the cookie
    // long after it could possibly be useful, and **does not extend anything**.
    maxAge: ACCESS_COOKIE_MAX_AGE,
  });
  return response;
}
