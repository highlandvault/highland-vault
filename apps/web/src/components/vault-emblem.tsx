/**
 * The vault door, drawn rather than photographed.
 *
 * Prize photography is blocked until the storage/CDN decision (O14), and a
 * hero with nothing in it reads as unfinished. This is `BrandMark` at poster
 * scale and built from the same parts — rounded frame, circle, spoked dial,
 * centre — so the two are recognisably one thing.
 *
 * **Five spokes, and no pointer.** An earlier version had four spokes at the
 * compass points and a long bar across the face, and every reading of it was
 * "clock". Five breaks the symmetry a dial needs to look like a time-teller,
 * and the frame around it is the other half of saying "door".
 *
 * Decorative only — `aria-hidden`, carrying no meaning the surrounding copy
 * does not already state. No intrinsic size: the layout decides how large it
 * is, and nothing here animates.
 */
export function VaultEmblem() {
  // Placed by angle rather than by hand, so the spacing stays exact at any size.
  const bolts = Array.from({ length: 8 }, (_, i) => (i * 360) / 8);
  const spokes = Array.from({ length: 5 }, (_, i) => (i * 360) / 5 - 18);

  return (
    <svg
      className="vault-emblem"
      viewBox="0 0 240 240"
      role="presentation"
      aria-hidden="true"
      focusable="false"
    >
      <defs>
        <radialGradient id="vault-glow" cx="50%" cy="44%" r="58%">
          <stop offset="0%" stopColor="#c8a24a" stopOpacity="0.28" />
          <stop offset="62%" stopColor="#c8a24a" stopOpacity="0.06" />
          <stop offset="100%" stopColor="#c8a24a" stopOpacity="0" />
        </radialGradient>
        <linearGradient id="vault-rim" x1="12%" y1="4%" x2="88%" y2="96%">
          <stop offset="0%" stopColor="#e2c884" />
          <stop offset="46%" stopColor="#c8a24a" />
          <stop offset="100%" stopColor="#8a6a21" />
        </linearGradient>
      </defs>

      {/* The light behind the door. */}
      <circle cx="120" cy="120" r="118" fill="url(#vault-glow)" />

      {/* The frame the door sits in — the brand mark's rounded square. */}
      <rect
        x="12"
        y="12"
        width="216"
        height="216"
        rx="34"
        fill="#101a2b"
        stroke="url(#vault-rim)"
        strokeOpacity="0.45"
        strokeWidth="1.5"
      />

      {/* Door: the seated plate, then the rim that stands proud of it. */}
      <circle cx="120" cy="120" r="88" fill="#0d1727" stroke="#2a3a57" strokeWidth="1" />
      <circle cx="120" cy="120" r="94" fill="none" stroke="url(#vault-rim)" strokeWidth="2" />

      {/* Bolts sunk around the door's edge. */}
      <g>
        {bolts.map((angle) => (
          <circle
            key={angle}
            cx="120"
            cy="42"
            r="4.5"
            fill="#16233a"
            stroke="#c8a24a"
            strokeOpacity="0.55"
            strokeWidth="1.25"
            transform={`rotate(${angle} 120 120)`}
          />
        ))}
      </g>

      {/* The hand-wheel. */}
      <circle cx="120" cy="120" r="54" fill="none" stroke="#2f4162" strokeWidth="1" />
      <circle cx="120" cy="120" r="48" fill="none" stroke="url(#vault-rim)" strokeWidth="2.5" />
      <g fill="url(#vault-rim)">
        {spokes.map((angle) => (
          <rect
            key={angle}
            x="116.5"
            y="73"
            width="7"
            height="32"
            rx="3.5"
            transform={`rotate(${angle} 120 120)`}
          />
        ))}
      </g>

      {/* The centre. */}
      <circle cx="120" cy="120" r="15" fill="#0c1524" stroke="url(#vault-rim)" strokeWidth="2" />
      <circle cx="120" cy="120" r="5" fill="#e2c884" />

      {/* A single arc of reflected light across the upper left of the rim. */}
      <path
        d="M 42 96 A 80 80 0 0 1 100 34"
        fill="none"
        stroke="#f3ead3"
        strokeOpacity="0.26"
        strokeWidth="2"
        strokeLinecap="round"
      />
    </svg>
  );
}
