const LABELS: Record<string, string> = {
  draft: 'Draft',
  scheduled: 'Opening soon',
  live: 'Open',
  closed: 'Closed',
  settled: 'Winners drawn',
  completed: 'Completed',
  cancelled: 'Cancelled',
};

export function StatusBadge({ status }: { status: string }) {
  return (
    <span className={`badge badge--${status}`} data-testid="draw-status">
      {LABELS[status] ?? status}
    </span>
  );
}
