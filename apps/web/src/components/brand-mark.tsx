/** Highland Vault mark: a vault door with a gold dial. Decorative. */
export function BrandMark() {
  return (
    <svg className="brand__mark" viewBox="0 0 32 32" aria-hidden="true">
      <rect
        x="2"
        y="2"
        width="28"
        height="28"
        rx="7"
        fill="none"
        stroke="#c8a24a"
        strokeWidth="2"
      />
      <circle cx="16" cy="16" r="7.5" fill="none" stroke="#c8a24a" strokeWidth="2" />
      <circle cx="16" cy="16" r="2" fill="#c8a24a" />
      <path d="M16 8.5v3M16 20.5v3M8.5 16h3M20.5 16h3" stroke="#c8a24a" strokeWidth="2" />
    </svg>
  );
}
