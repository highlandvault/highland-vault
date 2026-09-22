import { notFound } from 'next/navigation';
import type { ReactNode } from 'react';
import { hasPermission, requireSession } from '@/lib/session';

// Always rendered per request: access depends on the caller's session.
export const dynamic = 'force-dynamic';

/**
 * Admin shell (ADR-0009). This check only decides what to render; the API
 * enforces permissions again on every admin call and is the security boundary.
 * Accounts without admin access get a plain 404, which does not reveal the area.
 */
export default async function AdminLayout({ children }: { children: ReactNode }) {
  const me = await requireSession('/admin');
  if (!hasPermission(me, 'admin.access')) notFound();
  return (
    <section data-testid="admin-shell">
      <p>
        <strong>Admin</strong> — signed in as {me.user.email} (
        {me.roles.map((r) => (r.market ? `${r.role}:${r.market}` : r.role)).join(', ')})
      </p>
      {children}
    </section>
  );
}
