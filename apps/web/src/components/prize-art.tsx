/**
 * Artwork placeholder: there is no image pipeline yet (storage/CDN is OPEN
 * O14), so draws show a branded panel instead of a stock photo that would
 * misrepresent the prize.
 */
export function PrizeArt({ title }: { title: string }) {
  const initial = title.trim().charAt(0).toUpperCase() || '★';
  return (
    <div className="prize-art" role="img" aria-label={`Artwork placeholder for ${title}`}>
      <span className="prize-art__initial" aria-hidden="true">
        {initial}
      </span>
      <span className="prize-art__label" aria-hidden="true">
        Image coming soon
      </span>
    </div>
  );
}
