import Link from 'next/link';
import { PageShell } from '@/components/page-shell';

export default function NotFound() {
  return (
    <PageShell>
      <div className="empty-state">
        <h1>Not found</h1>
        <p>This page does not exist, or is not available in this market.</p>
        <Link className="button button--outline" href="/">
          Go to the home page
        </Link>
      </div>
    </PageShell>
  );
}
