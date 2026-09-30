/**
 * The Highland Vault mark: a stag's head, antlers spread, in gold.
 *
 * Replaces the vault-door dial the project started with. The brand is
 * "Highland Vault — whisky competitions", and a stag is what the design uses.
 * Drawn rather than imported: it is two dozen paths, not a dependency, and it
 * takes its colour from whatever is around it.
 *
 * Decorative — the words "Highland Vault" always sit beside it.
 */
export function BrandMark() {
  return (
    <svg className="brand__mark" viewBox="0 0 48 48" aria-hidden="true" focusable="false">
      <g
        fill="none"
        stroke="currentColor"
        strokeWidth="1.7"
        strokeLinecap="round"
        strokeLinejoin="round"
      >
        {/* Left antler: a main beam with three tines. */}
        <path d="M18.6 17.2c-1.9-2.2-3.1-4.6-3.4-7.3" />
        <path d="M15.2 9.9c-1.5.6-3 .5-4.5-.3M15.4 13.1c-1.8.2-3.5-.2-5.1-1.3M16.7 16c-1.9.5-3.8.5-5.6-.2" />
        <path d="M18.6 17.2c-2.6-.6-4.9-1.9-6.9-3.9" />
        {/* Right antler, mirrored. */}
        <path d="M29.4 17.2c1.9-2.2 3.1-4.6 3.4-7.3" />
        <path d="M32.8 9.9c1.5.6 3 .5 4.5-.3M32.6 13.1c1.8.2 3.5-.2 5.1-1.3M31.3 16c1.9.5 3.8.5 5.6-.2" />
        <path d="M29.4 17.2c2.6-.6 4.9-1.9 6.9-3.9" />
        {/* The head: brow, muzzle, jaw. */}
        <path d="M18.4 17.4c1.7-1.1 3.6-1.7 5.6-1.7s3.9.6 5.6 1.7" />
        <path d="M18.4 17.4c-.5 3.2-.2 6 1 8.6 1 2.2 2.2 4 3.6 5.6a1.3 1.3 0 0 0 2 0c1.4-1.6 2.6-3.4 3.6-5.6 1.2-2.6 1.5-5.4 1-8.6" />
        <path d="M21.4 33.6c.8 2.6 1.7 5 2.6 7.2.9-2.2 1.8-4.6 2.6-7.2" />
      </g>
      {/* Eyes. */}
      <circle cx="20.9" cy="21.6" r="1.25" fill="currentColor" />
      <circle cx="27.1" cy="21.6" r="1.25" fill="currentColor" />
    </svg>
  );
}
