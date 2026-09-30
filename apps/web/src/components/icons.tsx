/**
 * The icon set, drawn here rather than installed.
 *
 * Every icon is a stroked 24×24 outline on `currentColor`, so a parent decides
 * the colour and one rule keeps them consistent. They are decorative in every
 * current use — the label beside them carries the meaning — so they are
 * `aria-hidden` by default and never the only way to read something.
 *
 * No icon package: the project has no component library and is not getting one
 * for eight shapes.
 */
import type { SVGProps } from 'react';

type IconProps = Omit<SVGProps<SVGSVGElement>, 'children'>;

function Icon({ children, ...props }: IconProps & { children: React.ReactNode }) {
  return (
    <svg
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.6"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      focusable="false"
      {...props}
    >
      {children}
    </svg>
  );
}

/** A market. A globe, because a market is a place. */
export function GlobeIcon(props: IconProps) {
  return (
    <Icon {...props}>
      <circle cx="12" cy="12" r="9" />
      <path d="M3 12h18M12 3c2.5 2.6 2.5 15.4 0 18M12 3c-2.5 2.6-2.5 15.4 0 18" />
    </Icon>
  );
}

/** A competition: the bottle the brand is named for. */
export function BottleIcon(props: IconProps) {
  return (
    <Icon {...props}>
      <path d="M10 2.5h4v3.2c0 .9.3 1.7.9 2.4l.8 1a4 4 0 0 1 .9 2.5v8.4a1.5 1.5 0 0 1-1.5 1.5h-6a1.5 1.5 0 0 1-1.5-1.5v-8.4c0-.9.3-1.8.9-2.5l.8-1c.6-.7.9-1.5.9-2.4V2.5Z" />
      <path d="M8.6 13.5h6.8" />
    </Icon>
  );
}

/** Choosing: a list with a mark against one line. */
export function ListIcon(props: IconProps) {
  return (
    <Icon {...props}>
      <path d="M8 6h12M8 12h12M8 18h8" />
      <path d="M3.5 6h.01M3.5 12h.01M3.5 18h.01" />
    </Icon>
  );
}

/** Entering: a ticket. */
export function TicketIcon(props: IconProps) {
  return (
    <Icon {...props}>
      <path d="M3 8.5V6.8c0-.7.6-1.3 1.3-1.3h15.4c.7 0 1.3.6 1.3 1.3v1.7a2.5 2.5 0 0 0 0 7v1.7c0 .7-.6 1.3-1.3 1.3H4.3c-.7 0-1.3-.6-1.3-1.3v-1.7a2.5 2.5 0 0 0 0-7Z" />
      <path d="M14.5 5.5v13" />
    </Icon>
  );
}

/** Paying: a shield, for the checkout that holds nothing of the card. */
export function ShieldIcon(props: IconProps) {
  return (
    <Icon {...props}>
      <path d="M12 2.8 4.5 5.9v5.4c0 4.4 3.1 8.3 7.5 9.9 4.4-1.6 7.5-5.5 7.5-9.9V5.9Z" />
      <path d="m9 12 2.2 2.2L15.4 10" />
    </Icon>
  );
}

/** The result: a trophy. */
export function TrophyIcon(props: IconProps) {
  return (
    <Icon {...props}>
      <path d="M7 4h10v5a5 5 0 0 1-10 0Z" />
      <path d="M7 5.5H4.5v1A3.5 3.5 0 0 0 8 10M17 5.5h2.5v1A3.5 3.5 0 0 1 16 10" />
      <path d="M12 14v3.5M8.5 21h7M9.5 21c0-1.9 1.1-3.5 2.5-3.5s2.5 1.6 2.5 3.5" />
    </Icon>
  );
}

/** A question, for the skill question every entry answers. */
export function QuestionIcon(props: IconProps) {
  return (
    <Icon {...props}>
      <circle cx="12" cy="12" r="9" />
      <path d="M9.6 9.3a2.5 2.5 0 0 1 4.8.9c0 1.7-2.4 2.1-2.4 3.6" />
      <path d="M12 17.2h.01" />
    </Icon>
  );
}

/** A clock, for holds and deadlines. */
export function ClockIcon(props: IconProps) {
  return (
    <Icon {...props}>
      <circle cx="12" cy="12" r="9" />
      <path d="M12 7v5.2l3.2 1.9" />
    </Icon>
  );
}

/** The gold lozenge that marks the editorial banner. */
export function DiamondIcon(props: IconProps) {
  return (
    <Icon {...props}>
      <path d="M12 2.6 21.4 12 12 21.4 2.6 12Z" />
      <path d="M7.4 12 12 7.4l4.6 4.6L12 16.6Z" />
    </Icon>
  );
}

/** Search, in the header. */
export function SearchIcon(props: IconProps) {
  return (
    <Icon {...props}>
      <circle cx="10.8" cy="10.8" r="6.3" />
      <path d="m15.4 15.4 4.1 4.1" />
    </Icon>
  );
}

/** An account. */
export function UserIcon(props: IconProps) {
  return (
    <Icon {...props}>
      <circle cx="12" cy="8.2" r="3.7" />
      <path d="M4.8 20c.6-3.7 3.6-6 7.2-6s6.6 2.3 7.2 6" />
    </Icon>
  );
}

/** The arrow that ends a call to action. */
export function ArrowIcon(props: IconProps) {
  return (
    <Icon {...props}>
      <path d="M4.5 12h14M13 6.5l5.5 5.5L13 17.5" />
    </Icon>
  );
}
