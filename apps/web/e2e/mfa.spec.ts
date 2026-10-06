import { expect, type Page, test } from '@playwright/test';
import { readFileSync } from 'node:fs';
import { PASSWORD, STAFF_EMAIL_FILE, registerCustomer, signIn, totpNow } from './fixtures';

/**
 * One landmark, one h1, and nothing pushing the page sideways.
 *
 * Run against the two pages that carry the long strings — a 32-character
 * base32 key, and ten `ABCD-EFGH-IJKL-MNOP` codes — because those are what a
 * 320px panel is in danger of. Both are measured in place rather than from a
 * separate test, since each can only be reached once and only with a session.
 */
async function assertFitsEveryWidth(page: Page, label: string): Promise<void> {
  for (const width of [320, 375, 768, 1024, 1440, 1920]) {
    await page.setViewportSize({ width, height: 900 });
    const overflow = await page.evaluate(
      () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
    );
    expect(overflow, `${label} at ${width}px`).toBeLessThanOrEqual(0);
    await expect(page.locator('main#main')).toHaveCount(1);
    await expect(page.locator('main')).toHaveCount(1);
    await expect(page.getByRole('heading', { level: 1 })).toHaveCount(1);
  }
  await page.setViewportSize({ width: 1280, height: 900 });
}

/**
 * Enrolling a second factor in a real browser (UI-9).
 *
 * One journey, one account, and **one registration** — the last slot the
 * suite's budget has. A full run already spends nineteen of the twenty
 * registrations an hour the API allows one address (two staff accounts in
 * `global.setup.ts`, fourteen `registerCustomer` calls, `draws.spec.ts` again
 * on the `mobile` project, and two inline in `auth.spec.ts`), and `TRUST_PROXY`
 * is empty so no test can present a different one.
 *
 * The account is registered **inside this file** rather than shared, because
 * confirming changes it permanently: every later sign-in needs a second factor.
 * The `support` fixture account could not be used for that — `auth.spec.ts` and
 * `admin-draws.spec.ts` both sign into it expecting one step, the projects run
 * fully parallel, and no ordering makes giving it a factor safe. A unique email
 * per run is the only isolation another file cannot break. (The no-JavaScript
 * test below does use `support`, but stops before confirming, which leaves it
 * one-step; its own comment explains why that is safe.)
 *
 * Everything the API does is unchanged by this slice; what is new is that a
 * browser can now reach it.
 */

/** Wrong, and almost certainly not the live code — the same value the API's own suite uses. */
const WRONG_CODE = '000000';

test('a customer enrols a second factor, saves the codes, and is asked for one next time', async ({
  page,
  context,
}) => {
  const email = await registerCustomer(page, 'ui9-mfa');

  // ---- 1. it starts off ---------------------------------------------------
  await expect(page.getByTestId('account-mfa')).toContainText('Off');
  await page.getByTestId('account-security-link').click();
  await expect(page).toHaveURL(/\/account\/security$/);
  await expect(page.getByTestId('mfa-status')).toHaveText('Off');
  // Optional, and the page says so rather than implying a requirement (O8).
  await expect(page.getByTestId('mfa-optional')).toContainText('optional');
  await expect(page.locator('main#main')).toHaveCount(1);
  await expect(page.getByRole('heading', { level: 1 })).toHaveCount(1);

  // ---- 2. starting setup --------------------------------------------------
  await page.getByTestId('mfa-begin').click();
  await expect(page).toHaveURL(/\/account\/security\/setup$/);

  const secret = (await page.getByTestId('totp-secret').inputValue()).trim();
  // A 160-bit secret is 32 base32 characters. Asserted by shape, never printed.
  expect(secret).toMatch(/^[A-Z2-7]{32}$/);
  await expect(page.getByTestId('totp-otpauth-uri')).toContainText('otpauth://totp/');
  await expect(page.getByTestId('totp-code')).toBeVisible();

  /*
   * The key is not in the address bar, and neither is the setup link.
   *
   * This is the property the whole handoff exists to keep: a query string ends
   * up in history, in a `Referer` and in anything that logs a request line, so
   * a secret must never reach one. Checked here and again after every
   * navigation below.
   */
  expect(page.url()).not.toContain(secret);

  // ---- 3. the handoff cookie ---------------------------------------------
  const handoff = (await context.cookies()).find((c) => c.name === 'hv_mfa_setup');
  expect(handoff, 'the setup handoff cookie exists').toBeTruthy();
  expect(handoff!.httpOnly, 'HttpOnly').toBe(true);
  expect(handoff!.sameSite, 'SameSite=Lax').toBe('Lax');
  expect(handoff!.path, 'scoped to the enrolment pages').toBe('/account/security');
  // Short-lived: ten minutes, give or take the round trip.
  const lifetimeSeconds = handoff!.expires - Date.now() / 1000;
  expect(lifetimeSeconds).toBeGreaterThan(0);
  expect(lifetimeSeconds).toBeLessThanOrEqual(10 * 60 + 30);
  /*
   * Sealed, not merely HttpOnly.
   *
   * HttpOnly keeps page scripts out; it does nothing about the cookie store on
   * disk, where the recovery codes would otherwise sit in the clear and keep
   * working long after the session that made them expired. So the value must
   * not contain the thing it carries. The value itself is never printed — only
   * this predicate is.
   */
  expect(handoff!.value.includes(secret), 'the cookie does not carry the key in clear').toBe(false);

  // ---- 4. a wrong code keeps the same key --------------------------------
  await page.getByTestId('totp-code').fill(WRONG_CODE);
  await page.getByTestId('totp-confirm').click();
  await expect(page).toHaveURL(/\/account\/security\/setup\?error=INVALID_MFA_CODE$/);
  await expect(page.getByTestId('setup-error')).toContainText('invalid or has already been used');

  /*
   * The same key, exactly.
   *
   * The point of the whole design: `setup` mints a NEW secret every time it is
   * called, so a page that re-ran it to redraw itself would silently invalidate
   * the authenticator entry the customer had just made. A refusal must cost
   * them nothing but the attempt.
   */
  expect((await page.getByTestId('totp-secret').inputValue()).trim()).toBe(secret);
  await expect(page.getByTestId('totp-code')).toBeVisible();
  expect(page.url()).not.toContain(secret);

  // The key, the setup link and the error all have to fit a phone.
  await assertFitsEveryWidth(page, 'setup');

  // ---- 5. the right code --------------------------------------------------
  // Generated after the sweep, so the code is current when it is submitted.
  await page.getByTestId('totp-code').fill(totpNow(secret));
  await page.getByTestId('totp-confirm').click();
  await expect(page).toHaveURL(/\/account\/security\/recovery-codes$/);

  // ---- 6. ten codes, once -------------------------------------------------
  const codes = page.getByTestId('recovery-code');
  await expect(codes).toHaveCount(10);
  // Semantic list items, so the numbering is the document's and a screen
  // reader announces the count.
  expect(await page.locator('ol.recovery-codes > li').count()).toBe(10);
  const first = (await codes.first().textContent())!.trim();
  expect(first).toMatch(/^[A-Z2-7]{4}(-[A-Z2-7]{4}){3}$/);
  // The copyable block holds all ten, one per line.
  const block = await page.getByTestId('recovery-codes-text').inputValue();
  expect(block.split('\n')).toHaveLength(10);
  expect(block).toContain(first);
  // Not in the URL, and not in a cookie a script could read.
  expect(page.url()).not.toContain(first);
  const codesCookie = (await context.cookies()).find((c) => c.name === 'hv_mfa_codes');
  expect(codesCookie, 'the codes handoff cookie exists').toBeTruthy();
  expect(codesCookie!.httpOnly).toBe(true);
  expect(codesCookie!.value.includes(first), 'the cookie does not carry a code in clear').toBe(
    false,
  );
  // The setup handoff is gone the moment it is spent.
  expect((await context.cookies()).some((c) => c.name === 'hv_mfa_setup')).toBe(false);

  // Ten codes in a panel, down to 320px, before they are acknowledged away.
  await assertFitsEveryWidth(page, 'recovery codes');

  // ---- 7. acknowledging makes them unreachable ---------------------------
  await page.getByTestId('codes-acknowledge').click();
  await expect(page).toHaveURL(/\/account\/security\?enrolled=1$/);
  await expect(page.getByTestId('security-enrolled')).toBeVisible();
  await expect(page.getByTestId('mfa-status')).toHaveText('On');
  expect((await context.cookies()).some((c) => c.name === 'hv_mfa_codes')).toBe(false);

  // Going back to the address shows nothing: there is no state left, and the
  // API keeps only hashes, so nothing could render them again.
  await page.goto('/account/security/recovery-codes');
  await expect(page).toHaveURL(/\/account\/security$/);
  await expect(page.getByTestId('recovery-code')).toHaveCount(0);

  // ---- 8. an enrolled account cannot start again -------------------------
  // No invitation on the page...
  await expect(page.getByTestId('mfa-begin')).toHaveCount(0);
  await expect(page.getByTestId('mfa-on-note')).toBeVisible();
  // ...and the page it would have led to has nothing to show either. The API
  // would refuse a second setup with MFA_ALREADY_ENABLED in any case; this is
  // the browser never getting the chance to ask.
  await page.goto('/account/security/setup');
  await expect(page).toHaveURL(/\/account\/security$/);
  await expect(page.getByTestId('totp-secret')).toHaveCount(0);

  // The account page agrees.
  await page.goto('/account');
  await expect(page.getByTestId('account-mfa')).toContainText('On');

  // ---- 9. and the second step is real next time -------------------------
  await page.getByRole('button', { name: 'Sign out' }).click();
  await expect(page).toHaveURL(/\/login$/);

  await signIn(page, email);
  // Signed in as far as the password goes, and no further.
  await expect(page).toHaveURL(/\/login\/mfa/);
  await expect(page.getByRole('heading', { name: 'Two-step verification' })).toBeVisible();
  // The account is not reachable until the factor is given.
  await page.goto('/account');
  await expect(page).toHaveURL(/\/login\/mfa\?next=%2Faccount$/);
});

test('enrolment starts with JavaScript disabled', async ({ browser }) => {
  /*
   * The no-JavaScript path, proved rather than asserted.
   *
   * Everything in this flow is a Server Component and a plain `<form>` whose
   * action is a Server Action, so it should survive scripting being off — but
   * "should" is what a test is for. This context has it off outright: no
   * hydration, no client router, no `fetch`.
   *
   * **It signs in as the existing `support` fixture account and stops at the
   * setup page.** Two reasons. There is no registration left in the budget for
   * a second account, and this costs none — it is a sign-in, and
   * `loginPerEmail` allows ten a quarter-hour against the two or three the
   * suite already uses. And it must not CONFIRM, because confirming would give
   * a shared fixture account a second factor and every other test that signs
   * into it would then meet a step it does not expect.
   *
   * Stopping here is safe in a way that is worth being precise about: `setup`
   * writes a row with `confirmed_at` NULL, and nothing treats that as enrolled
   * — sign-in checks `confirmed_at`, `/auth/me` reports `mfaEnabled` from it,
   * and only `confirm` revokes other sessions. So `support` is left exactly as
   * usable as it was, one step and all.
   *
   * What it proves is the mechanism the whole slice rests on: a form POST with
   * no script reaches a Server Action, which redirects, and the next page
   * renders the handoff. The journey above covers the rest with scripting on,
   * where the width measurements need it.
   */
  const noJs = await browser.newContext({ javaScriptEnabled: false });
  try {
    const page = await noJs.newPage();
    const email = readFileSync(STAFF_EMAIL_FILE, 'utf8').trim();

    // A server redirect, with nothing to follow it but the browser.
    await page.goto('/account/security');
    await expect(page).toHaveURL(/\/login\?next=%2Faccount%2Fsecurity$/);

    // A plain form posting to a Server Action.
    await page.getByLabel('Email').fill(email);
    await page.getByLabel('Password').fill(PASSWORD);
    await page.getByRole('button', { name: 'Sign in' }).click();
    await expect(page).toHaveURL(/\/account\/security$/);
    await expect(page.getByTestId('mfa-status')).toHaveText('Off');

    // The enrolment action itself, without a line of client script.
    await page.getByTestId('mfa-begin').click();
    await expect(page).toHaveURL(/\/account\/security\/setup$/);
    const secret = (await page.getByTestId('totp-secret').inputValue()).trim();
    expect(secret).toMatch(/^[A-Z2-7]{32}$/);
    expect(page.url()).not.toContain(secret);
    await expect(page.getByTestId('totp-code')).toBeVisible();

    // And it stops here, on purpose: see above.
  } finally {
    await noJs.close();
  }
});

test('the enrolment pages are unreachable without a session', async ({ browser }) => {
  // No registration: a fresh context with no cookies at all.
  const anonymous = await browser.newContext();
  try {
    const visitor = await anonymous.newPage();
    for (const path of [
      '/account/security',
      '/account/security/setup',
      '/account/security/recovery-codes',
    ]) {
      await visitor.goto(path);
      await expect(visitor).toHaveURL(/\/login\?next=/);
      await expect(visitor.getByTestId('totp-secret')).toHaveCount(0);
      await expect(visitor.getByTestId('recovery-code')).toHaveCount(0);
    }
  } finally {
    await anonymous.close();
  }
});
