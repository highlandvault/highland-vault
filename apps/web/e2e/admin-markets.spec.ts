import { expect, type BrowserContext, type Page, test } from '@playwright/test';
import { readFileSync } from 'node:fs';
import {
  NO_MFA_ADMIN_EMAIL_FILE,
  STAFF_EMAIL_FILE,
  SUPER_ADMIN_EMAIL_FILE,
  SUPER_ADMIN_TOTP_FILE,
  signIn,
  totpNow,
} from './fixtures';

/**
 * Market gate operations in a real browser (UI-10).
 *
 * ## No registration
 *
 * Every account here already exists. The suite's registration budget was
 * already at twenty of the twenty an hour the API allows one address, so the
 * two staff fixtures these tests use are seeded straight into the e2e database
 * by `e2e:prepare` and given their role by `global.setup.ts`. Nothing here
 * registers, and no shared account is given a second factor.
 *
 * ## What is deliberately NOT asserted here, and why
 *
 * **A successful gate change, and a successful legal approval.** Both are
 * covered by `apps/api/test/admin-markets.int.test.ts`, and neither can be
 * done safely from this suite: the only market that is not already enabled is
 * Germany, and `auth.spec.ts` asserts that Germany shows "required, not
 * recorded" and lists `min_age, self_exclusion_required` as missing, while
 * `smoke.spec.ts` and `draws.spec.ts` assert it is blocked everywhere. The
 * projects run fully parallel, so there is no ordering or teardown that makes
 * the window safe. Breaking three other specs intermittently to claim coverage
 * here would be a bad trade.
 *
 * What the browser proves instead: the forms reach the API, a refusal is
 * explained rather than dumped, step-up intervenes *before* any mutation, and
 * the success path works — through a settings save that writes the values the
 * market already has, which is a real audited operation that changes nothing
 * anybody else observes.
 */

const SUPER_ADMIN = () => readFileSync(SUPER_ADMIN_EMAIL_FILE, 'utf8').trim();
const TOTP_SECRET = () => readFileSync(SUPER_ADMIN_TOTP_FILE, 'utf8').trim();

const PERIOD_MS = 30_000;
/** The last step this process has spent, so the next code is always a later one. */
let lastStep: number | null = null;

/**
 * A code the API has not seen before.
 *
 * `global.setup.ts` spent a step enrolling the factor, and each sign-in spends
 * another. The current code would therefore be refused as a replay for up to
 * thirty seconds, so this asks for the next unused step and waits only if that
 * would fall outside the ±1 drift window the API allows.
 */
async function unusedTotp(secret: string): Promise<string> {
  for (;;) {
    const current = Math.floor(Date.now() / PERIOD_MS);
    const step = lastStep === null ? current + 1 : Math.max(lastStep + 1, current);
    if (step <= current + 1) {
      lastStep = step;
      return totpNow(secret, step * PERIOD_MS);
    }
    await new Promise((resolve) => setTimeout(resolve, 1000));
  }
}

/** Signs in and satisfies the second factor the account always needs. */
async function signInAsSuperAdmin(page: Page, next: string): Promise<void> {
  await signIn(page, SUPER_ADMIN(), next);
  await expect(page).toHaveURL(/\/login\/mfa/);
  // From the fixture secret, and never written to the test output.
  await page.getByLabel(/Code from your authenticator/).fill(await unusedTotp(TOTP_SECRET()));
  await page.getByRole('button', { name: 'Verify' }).click();
  await expect(page).toHaveURL(new RegExp(`${next.replace(/\//g, '\\/')}$`));
}

async function overflowOf(page: Page): Promise<number> {
  return page.evaluate(
    () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
  );
}

test.describe('market operations', () => {
  /*
   * Serial, one worker, and signed in exactly once.
   *
   * A TOTP code is single-use — the API accepts a step only if it is strictly
   * later than the last one it accepted — so signing in per test would make
   * each one wait out a thirty-second window, and parallel workers are
   * separate processes that could not agree on which steps they had spent.
   * One sign-in for the whole block costs one step and no waiting.
   */
  test.describe.configure({ mode: 'serial' });

  let context: BrowserContext;
  let page: Page;

  test.beforeAll(async ({ browser }) => {
    context = await browser.newContext();
    page = await context.newPage();
    await signInAsSuperAdmin(page, '/admin/markets');
  });

  test.afterAll(async () => {
    await context.close();
  });

  test.beforeEach(async () => {
    await page.setViewportSize({ width: 1280, height: 900 });
  });

  test('the overview lists every market, including disabled Germany', async () => {
    await page.goto('/admin/markets');
    await expect(page.getByRole('heading', { level: 1, name: 'Markets' })).toBeVisible();

    // All three, and Germany in particular: this is not the public
    // availability list, and a disabled market is the main reason to be here.
    for (const code of ['uk', 'ie', 'de']) {
      await expect(page.getByTestId(`market-row-${code}`)).toBeVisible();
    }
    await expect(page.getByTestId('market-gate-de')).toContainText('disabled');
    await expect(page.getByTestId('market-gate-uk')).toContainText('enabled');
    // Missing settings are the API's answer, printed as given.
    await expect(page.getByTestId('market-missing-de')).toContainText('min_age');
    await expect(page.getByTestId('market-missing-uk')).toContainText('complete');

    await expect(page.locator('main#main')).toHaveCount(1);
    await expect(page.getByRole('heading', { level: 1 })).toHaveCount(1);
  });

  test('a market page shows its state and the operations on it', async () => {
    await page.goto('/admin/markets/de');

    await expect(page.getByTestId('state-gate')).toHaveText('disabled');
    await expect(page.getByTestId('state-available')).toHaveText('no');
    // Unset is shown as unset, never as a zero or a guess (O12 is open).
    await expect(page.getByTestId('state-min-age')).toContainText('not set');
    await expect(page.getByTestId('state-self-exclusion')).toContainText('not set');
    await expect(page.getByTestId('state-missing')).toContainText('min_age');
    await expect(page.getByTestId('state-legal')).toContainText('is not recorded');

    // Each operation has its own reason field; none is hidden or generated.
    await expect(page.getByTestId('settings-reason')).toBeVisible();
    await expect(page.getByTestId('legal-reason')).toBeVisible();
    await expect(page.getByTestId('gate-reason')).toBeVisible();
    await expect(page.getByTestId('gate-submit')).toContainText('Enable DE');
  });

  test('the backend stays authoritative about whether a market may be enabled', async () => {
    await page.goto('/admin/markets/de');

    // Germany has neither its compliance settings nor its legal approval, so
    // the API refuses. The page offers the form anyway — it computes no verdict
    // of its own on readiness — and explains the refusal in words.
    await page.getByTestId('gate-confirm').fill('DE');
    await page.getByTestId('gate-reason').fill('e2e: proving the gate refuses an unready market');
    await page.getByTestId('gate-submit').click();

    const error = page.getByTestId('market-op-error');
    await expect(error).toBeVisible();
    const message = (await error.textContent()) ?? '';
    // A sentence. Not a code dump, not JSON, not SQL.
    expect(message).toMatch(/cannot be enabled until/);
    expect(message).not.toContain('{');
    expect(message).not.toMatch(/constraint|violates|pg_|stack|at Object/i);

    // And nothing changed.
    await expect(page.getByTestId('state-gate')).toHaveText('disabled');
    await expect(page.getByTestId('state-available')).toHaveText('no');
  });

  test('the confirmation has to match before anything is sent', async () => {
    await page.goto('/admin/markets/de');
    await page.getByTestId('gate-confirm').fill('UK');
    await page.getByTestId('gate-reason').fill('e2e: wrong confirmation, nothing should happen');
    await page.getByTestId('gate-submit').click();

    await expect(page.getByTestId('market-op-error')).toContainText('did not match');
    await expect(page.getByTestId('state-gate')).toHaveText('disabled');
  });

  test('a sensitive operation succeeds once the second factor is fresh', async () => {
    /*
     * A real, audited `market.settings.updated` that changes nothing.
     *
     * The values submitted are the ones `e2e:prepare` already set for the UK
     * (`TEST_FIXTURE_COMPLIANCE`: 18, required), so the operation goes the
     * whole way — permission, reason, fresh step-up, the API's transaction, the
     * audit row — and leaves every value as it found it. No other spec can see
     * a difference, which is what makes it safe in a parallel suite.
     */
    await page.goto('/admin/markets/uk');
    await expect(page.getByTestId('state-min-age')).toHaveText('18');

    await page.getByTestId('settings-min-age').fill('18');
    await page.getByTestId('settings-self-exclusion').selectOption('true');
    await page.getByTestId('settings-reason').fill('e2e: re-saving the existing fixture values');
    await page.getByTestId('settings-submit').click();

    await expect(page.getByTestId('market-op-saved')).toContainText('settings saved');
    await expect(page.getByTestId('market-op-error')).toHaveCount(0);
    // Re-read from the API, and unchanged.
    await expect(page.getByTestId('state-min-age')).toHaveText('18');
    await expect(page.getByTestId('state-self-exclusion')).toHaveText('yes');
    await expect(page.getByTestId('state-missing')).toContainText('All required');
    // The UK is left exactly as every other spec expects it.
    await expect(page.getByTestId('state-gate')).toHaveText('enabled');
    await expect(page.getByTestId('state-available')).toHaveText('yes');
  });

  test('the pages hold one landmark and no overflow at any width', async () => {
    for (const width of [320, 375, 768, 1024, 1440, 1920]) {
      await page.setViewportSize({ width, height: 900 });
      for (const path of ['/admin/markets', '/admin/markets/de']) {
        await page.goto(path);
        expect(await overflowOf(page), `${path} at ${width}px`).toBeLessThanOrEqual(0);
        await expect(page.locator('main#main')).toHaveCount(1);
        await expect(page.locator('main')).toHaveCount(1);
        await expect(page.getByRole('heading', { level: 1 })).toHaveCount(1);
      }
    }
  });

  test('the operation forms work with JavaScript disabled', async ({ browser }) => {
    // Its own context, so a second sign-in and a second step — which is why
    // this block is serial and the step counter exists.
    const noJs = await browser.newContext({ javaScriptEnabled: false });
    try {
      const unscripted = await noJs.newPage();
      await signInAsSuperAdmin(unscripted, '/admin/markets/de');

      await unscripted.getByTestId('gate-confirm').fill('DE');
      await unscripted.getByTestId('gate-reason').fill('e2e: no-JavaScript refusal path');
      await unscripted.getByTestId('gate-submit').click();

      // The server redirected and re-rendered with the explanation; no script
      // was involved at any point.
      await expect(unscripted.getByTestId('market-op-error')).toContainText(
        'cannot be enabled until',
      );
      await expect(unscripted.getByTestId('state-gate')).toHaveText('disabled');
    } finally {
      await noJs.close();
    }
  });
});

test('an operator with no second factor is sent to enrol, and nothing is changed', async ({
  page,
}) => {
  /*
   * The step-up path, and the reason UI-10 exists.
   *
   * This account holds `markets.gate.manage` and has never enrolled, so the
   * API refuses every sensitive route with `STEP_UP_REQUIRED`. Before this
   * slice that was a dead end: no admin page mentioned MFA, and the operator
   * had nowhere to go. It needs no TOTP code, so it runs outside the serial
   * block above.
   */
  const email = readFileSync(NO_MFA_ADMIN_EMAIL_FILE, 'utf8').trim();
  await signIn(page, email, '/admin/markets/de');
  await expect(page).toHaveURL(/\/admin\/markets\/de$/);
  // It has the permission, so the forms are offered.
  await expect(page.getByTestId('gate-submit')).toBeVisible();

  await page.getByTestId('gate-confirm').fill('DE');
  await page.getByTestId('gate-reason').fill('e2e: step-up should intervene before anything runs');
  await page.getByTestId('gate-submit').click();

  // Explained, not dumped, and with somewhere to go.
  await expect(page.getByTestId('market-op-error')).toContainText('second factor');
  const link = page.getByTestId('market-stepup-enrol');
  await expect(link).toBeVisible();
  await expect(link).toHaveAttribute('href', '/account/security');
  // No return URL to tamper with: the page came back to was built server-side
  // from the market code the action had already validated.
  expect(page.url()).toMatch(/\/admin\/markets\/de\?/);
  expect(page.url()).not.toContain('next=');

  // **Nothing happened.** The mutation did not run and will not until the
  // operator submits again with a factor verified.
  await expect(page.getByTestId('state-gate')).toHaveText('disabled');
  await expect(page.getByTestId('state-available')).toHaveText('no');

  // And the link reaches the enrolment surface UI-9 built.
  await link.click();
  await expect(page).toHaveURL(/\/account\/security$/);
  await expect(page.getByTestId('mfa-status')).toHaveText('Off');
});

test('staff without the gate permission are offered no controls', async ({ page }) => {
  // The support fixture: admin.access, but not markets.gate.manage, and no
  // second factor, so one step. Nothing is mutated.
  await signIn(page, readFileSync(STAFF_EMAIL_FILE, 'utf8').trim(), '/admin/markets/de');
  await expect(page).toHaveURL(/\/admin\/markets\/de$/);

  // It can read the state...
  await expect(page.getByTestId('state-gate')).toHaveText('disabled');
  // ...and is told plainly that it cannot change it.
  await expect(page.getByTestId('market-read-only')).toBeVisible();
  // No form, no submit, no reason field.
  await expect(page.getByTestId('gate-submit')).toHaveCount(0);
  await expect(page.getByTestId('settings-submit')).toHaveCount(0);
  await expect(page.getByTestId('legal-submit')).toHaveCount(0);
});
