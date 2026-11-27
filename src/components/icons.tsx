// Plain SVG icons. The shape differs per status so color is never the only signal.

interface IconProps {
  className?: string;
}

function Svg({ className, children }: IconProps & { children: React.ReactNode }) {
  return (
    <svg
      className={className}
      width="20"
      height="20"
      viewBox="0 0 20 20"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.8"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      {children}
    </svg>
  );
}

export function OkIcon({ className }: IconProps) {
  return (
    <Svg className={className}>
      <circle cx="10" cy="10" r="7.5" />
      <path d="M6.6 10.2l2.4 2.4 4.4-4.9" />
    </Svg>
  );
}

export function ProblemIcon({ className }: IconProps) {
  return (
    <Svg className={className}>
      <path d="M10 2.8l7.4 13H2.6z" />
      <path d="M10 8v3.6M10 14.1v.1" />
    </Svg>
  );
}

export function UnknownIcon({ className }: IconProps) {
  return (
    <Svg className={className}>
      <circle cx="10" cy="10" r="7.5" strokeDasharray="2.4 2.6" />
    </Svg>
  );
}

export function ExternalIcon({ className }: IconProps) {
  return (
    <Svg className={className}>
      <path d="M8 4.5H5a1.5 1.5 0 0 0-1.5 1.5v9A1.5 1.5 0 0 0 5 16.5h9a1.5 1.5 0 0 0 1.5-1.5v-3" />
      <path d="M11.5 3.5h5v5M16.5 3.5L9.5 10.5" />
    </Svg>
  );
}

export function ChevronIcon({ className }: IconProps) {
  return (
    <Svg className={className}>
      <path d="M6 8l4 4 4-4" />
    </Svg>
  );
}
