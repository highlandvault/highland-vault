import type { ReactNode } from 'react';

/** Main content area for pages outside a market (home, account, admin). */
export function PageShell({ children }: { children: ReactNode }) {
  return (
    <main id="main" className="site-main">
      <div className="container">{children}</div>
    </main>
  );
}
