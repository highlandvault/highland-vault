/**
 * A photograph's slot, before there is a photograph.
 *
 * The design is photography-led: a Highland landscape behind the hero, a
 * bottle, a desk of gadgets, a car, a house, a bay. **This repository contains
 * no image files at all** — there is no `public/` directory and not one png,
 * jpg or webp — and prize photography is blocked by O14.
 *
 * So each slot is drawn: layered gradients and a few SVG silhouettes, sized
 * and positioned exactly where the real image goes. Two consequences worth
 * knowing:
 *
 * 1. **Nothing is downloaded and nothing is hotlinked.** No copyrighted
 *    product shot is embedded, and no external URL is invented.
 * 2. **Dropping in the real photograph is one line per slot.** Put the file in
 *    `public/`, give this component an `src`, and it renders the image instead
 *    of the scene. The container, aspect ratio and overlay do not change, so
 *    the layout is already correct.
 *
 * The scenes are decorative. Where one stands in for a prize, the prize is
 * named in text beside it, so nothing is conveyed by the picture alone.
 */
import type { ReactNode } from 'react';

export type SceneKind =
  'highland' | 'whisky' | 'tech' | 'cars' | 'property' | 'experiences' | 'barrels';

export function Scene({
  kind,
  className,
  children,
}: {
  kind: SceneKind;
  className?: string;
  children?: ReactNode;
}) {
  return (
    <span className={`scene scene--${kind}${className ? ` ${className}` : ''}`} aria-hidden="true">
      <span className="scene__wash" />
      {SILHOUETTES[kind]}
      {children}
    </span>
  );
}

/** A ridge line. Two of them, at different opacities, read as depth. */
function Mountains() {
  return (
    <svg className="scene__art" viewBox="0 0 400 200" preserveAspectRatio="none" aria-hidden="true">
      <path
        d="M0 200V128l38-34 30 22 34-46 42 52 30-20 46 38 34-52 40 44 32-26 34 30v64Z"
        fill="currentColor"
        opacity="0.28"
      />
      <path
        d="M0 200v-42l46-30 36 26 40-40 44 44 36-26 48 40 40-34 34 28 40-20v54Z"
        fill="currentColor"
        opacity="0.5"
      />
    </svg>
  );
}

/** A bottle and a glass, in outline. */
function Bottle() {
  return (
    <svg className="scene__art scene__art--object" viewBox="0 0 200 200" aria-hidden="true">
      <g fill="currentColor" opacity="0.55">
        <path d="M86 28h28v26c0 9 3 13 8 19l7 9c5 7 8 14 8 23v72a8 8 0 0 1-8 8H71a8 8 0 0 1-8-8v-72c0-9 3-16 8-23l7-9c5-6 8-10 8-19Z" />
      </g>
      <rect x="70" y="96" width="60" height="38" rx="3" fill="currentColor" opacity="0.85" />
      <path
        d="M148 140h34l-5 34a10 10 0 0 1-10 9h-4a10 10 0 0 1-10-9Z"
        fill="currentColor"
        opacity="0.4"
      />
    </svg>
  );
}

function Devices() {
  return (
    <svg className="scene__art scene__art--object" viewBox="0 0 200 200" aria-hidden="true">
      <g fill="currentColor" opacity="0.5">
        <rect x="58" y="42" width="52" height="106" rx="10" />
        <rect x="118" y="66" width="40" height="82" rx="8" opacity="0.7" />
      </g>
      <circle cx="84" cy="160" r="16" fill="currentColor" opacity="0.35" />
    </svg>
  );
}

function Car() {
  return (
    <svg className="scene__art scene__art--object" viewBox="0 0 200 200" aria-hidden="true">
      <path
        d="M28 132c0-10 8-16 18-20l22-26c5-6 12-9 20-9h38c9 0 17 4 22 11l16 24c10 3 18 10 18 20v12H28Z"
        fill="currentColor"
        opacity="0.55"
      />
      <circle cx="62" cy="148" r="14" fill="currentColor" opacity="0.8" />
      <circle cx="140" cy="148" r="14" fill="currentColor" opacity="0.8" />
    </svg>
  );
}

function House() {
  return (
    <svg className="scene__art scene__art--object" viewBox="0 0 200 200" aria-hidden="true">
      <path d="M26 100 100 48l74 52v58H26Z" fill="currentColor" opacity="0.5" />
      <rect x="62" y="112" width="30" height="46" fill="currentColor" opacity="0.8" />
      <rect x="110" y="112" width="30" height="24" fill="currentColor" opacity="0.7" />
      <rect x="20" y="158" width="160" height="6" rx="3" fill="currentColor" opacity="0.4" />
    </svg>
  );
}

function Bay() {
  return (
    <svg className="scene__art" viewBox="0 0 400 200" preserveAspectRatio="none" aria-hidden="true">
      <path
        d="M0 200v-58l52-36 44 32 48-44 56 50 44-34 56 44 44-30 56 40v36Z"
        fill="currentColor"
        opacity="0.38"
      />
      <path d="M0 200v-22h400v22Z" fill="currentColor" opacity="0.6" />
    </svg>
  );
}

/** Staves, for the dark banner. */
function Barrels() {
  return (
    <svg className="scene__art" viewBox="0 0 400 120" preserveAspectRatio="none" aria-hidden="true">
      {/* Staves, end-on: narrow and full height, so they read as a row of
          barrels rather than a line of circles. */}
      <g fill="currentColor" opacity="0.32">
        {Array.from({ length: 16 }, (_, i) => (
          <rect key={i} x={2 + i * 25} y="6" width="19" height="108" rx="9" />
        ))}
      </g>
    </svg>
  );
}

const SILHOUETTES: Record<SceneKind, ReactNode> = {
  highland: <Mountains />,
  whisky: <Bottle />,
  tech: <Devices />,
  cars: <Car />,
  property: <House />,
  experiences: <Bay />,
  barrels: <Barrels />,
};
