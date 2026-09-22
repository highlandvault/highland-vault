'use server';

import { LoginResponseSchema } from '@hv/contracts';
import { redirect } from 'next/navigation';
import { adoptSessionCookie, apiFetch } from '@/lib/api';

/** Only same-site relative paths may be used as a post-login destination (no open redirects). */
function safeNext(value: FormDataEntryValue | null): string {
  const next = typeof value === 'string' ? value : '';
  return next.startsWith('/') && !next.startsWith('//') && !next.startsWith('/\\')
    ? next
    : '/account';
}

const text = (form: FormData, name: string) => {
  const value = form.get(name);
  return typeof value === 'string' ? value : '';
};

export async function login(form: FormData): Promise<void> {
  const next = safeNext(form.get('next'));
  const result = await apiFetch('/auth/login', {
    method: 'POST',
    body: { email: text(form, 'email'), password: text(form, 'password') },
    parse: (json) => LoginResponseSchema.parse(json),
  });
  if (!result.ok) {
    redirect(`/login?error=${result.code}&next=${encodeURIComponent(next)}`);
  }
  await adoptSessionCookie(result.response);
  redirect(
    result.data.status === 'mfa_required' ? `/login/mfa?next=${encodeURIComponent(next)}` : next,
  );
}

export async function verifyMfa(form: FormData): Promise<void> {
  const next = safeNext(form.get('next'));
  const code = text(form, 'code').trim();
  const body = /^\d{6}$/.test(code) ? { code } : { recoveryCode: code };
  const result = await apiFetch('/auth/mfa/verify', { method: 'POST', body });
  if (!result.ok) {
    redirect(`/login/mfa?error=${result.code}&next=${encodeURIComponent(next)}`);
  }
  redirect(next);
}

export async function register(form: FormData): Promise<void> {
  const result = await apiFetch('/auth/register', {
    method: 'POST',
    body: { email: text(form, 'email'), password: text(form, 'password') },
  });
  if (!result.ok) {
    redirect(`/register?error=${result.code}`);
  }
  await adoptSessionCookie(result.response);
  redirect('/account');
}

export async function logout(): Promise<void> {
  const result = await apiFetch('/auth/logout', { method: 'POST' });
  if (result.ok) await adoptSessionCookie(result.response);
  redirect('/login');
}
