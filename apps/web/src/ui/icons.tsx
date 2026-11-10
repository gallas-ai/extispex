import type { ReactNode } from "react";

interface IconProps {
  size?: number;
  className?: string;
}

/** Stroke icons drawn on a 24-unit grid, after the Lucide set (ISC licence). */
function StrokeIcon({ size = 16, className, children }: IconProps & { children: ReactNode }) {
  return (
    <svg
      className={className ? `icon ${className}` : "icon"}
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={2}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      focusable="false"
    >
      {children}
    </svg>
  );
}

export const SearchIcon = (props: IconProps) => (
  <StrokeIcon {...props}>
    <circle cx="11" cy="11" r="8" />
    <path d="m21 21-4.3-4.3" />
  </StrokeIcon>
);

export const RefreshIcon = (props: IconProps) => (
  <StrokeIcon {...props}>
    <path d="M3 12a9 9 0 0 1 9-9 9.75 9.75 0 0 1 6.74 2.74L21 8" />
    <path d="M21 3v5h-5" />
    <path d="M21 12a9 9 0 0 1-9 9 9.75 9.75 0 0 1-6.74-2.74L3 16" />
    <path d="M8 16H3v5" />
  </StrokeIcon>
);

export const CloseIcon = (props: IconProps) => (
  <StrokeIcon {...props}>
    <path d="M18 6 6 18" />
    <path d="m6 6 12 12" />
  </StrokeIcon>
);

export const MenuIcon = (props: IconProps) => (
  <StrokeIcon {...props}>
    <path d="M4 6h16" />
    <path d="M4 12h16" />
    <path d="M4 18h16" />
  </StrokeIcon>
);

export const CopyIcon = (props: IconProps) => (
  <StrokeIcon {...props}>
    <rect width="14" height="14" x="8" y="8" rx="2" />
    <path d="M4 16c-1.1 0-2-.9-2-2V4c0-1.1.9-2 2-2h10c1.1 0 2 .9 2 2" />
  </StrokeIcon>
);

export const CheckIcon = (props: IconProps) => (
  <StrokeIcon {...props}>
    <path d="M20 6 9 17l-5-5" />
  </StrokeIcon>
);

export const ChevronRightIcon = (props: IconProps) => (
  <StrokeIcon {...props}>
    <path d="m9 18 6-6-6-6" />
  </StrokeIcon>
);

export const KeyIcon = (props: IconProps) => (
  <StrokeIcon {...props}>
    <path d="M2.586 17.414A2 2 0 0 0 2 18.828V21a1 1 0 0 0 1 1h3a1 1 0 0 0 1-1v-1a1 1 0 0 1 1-1h1a1 1 0 0 0 1-1v-1a1 1 0 0 1 1-1h.172a2 2 0 0 0 1.414-.586l.814-.814a6.5 6.5 0 1 0-4-4z" />
    <circle cx="16.5" cy="7.5" r=".5" fill="currentColor" />
  </StrokeIcon>
);

export const SunIcon = (props: IconProps) => (
  <StrokeIcon {...props}>
    <circle cx="12" cy="12" r="4" />
    <path d="M12 2v2M12 20v2M4.93 4.93l1.41 1.41M17.66 17.66l1.41 1.41M2 12h2M20 12h2M6.34 17.66l-1.41 1.41M19.07 4.93l-1.41 1.41" />
  </StrokeIcon>
);

export const MoonIcon = (props: IconProps) => (
  <StrokeIcon {...props}>
    <path d="M12 3a6 6 0 0 0 9 9 9 9 0 1 1-9-9Z" />
  </StrokeIcon>
);

export const MonitorIcon = (props: IconProps) => (
  <StrokeIcon {...props}>
    <rect width="20" height="14" x="2" y="3" rx="2" />
    <path d="M8 21h8M12 17v4" />
  </StrokeIcon>
);

export const FilterIcon = (props: IconProps) => (
  <StrokeIcon {...props}>
    <path d="M22 3H2l8 9.46V19l4 2v-8.54L22 3z" />
  </StrokeIcon>
);

export const AlertIcon = (props: IconProps) => (
  <StrokeIcon {...props}>
    <circle cx="12" cy="12" r="10" />
    <path d="M12 8v4M12 16h.01" />
  </StrokeIcon>
);

export const EyeIcon = (props: IconProps) => (
  <StrokeIcon {...props}>
    <path d="M2.062 12.348a1 1 0 0 1 0-.696 10.75 10.75 0 0 1 19.876 0 1 1 0 0 1 0 .696 10.75 10.75 0 0 1-19.876 0" />
    <circle cx="12" cy="12" r="3" />
  </StrokeIcon>
);

export const EyeOffIcon = (props: IconProps) => (
  <StrokeIcon {...props}>
    <path d="M10.733 5.076a10.744 10.744 0 0 1 11.205 6.575 1 1 0 0 1 0 .696 10.747 10.747 0 0 1-1.444 2.49" />
    <path d="M14.084 14.158a3 3 0 0 1-4.242-4.242" />
    <path d="M17.479 17.499a10.75 10.75 0 0 1-15.417-5.151 1 1 0 0 1 0-.696 10.75 10.75 0 0 1 4.446-5.143" />
    <path d="m2 2 20 20" />
  </StrokeIcon>
);

export const SparklesIcon = (props: IconProps) => (
  <StrokeIcon {...props}>
    <path d="M9.937 15.5A2 2 0 0 0 8.5 14.063l-6.135-1.582a.5.5 0 0 1 0-.962L8.5 9.936A2 2 0 0 0 9.937 8.5l1.582-6.135a.5.5 0 0 1 .963 0L14.063 8.5A2 2 0 0 0 15.5 9.937l6.135 1.581a.5.5 0 0 1 0 .964L15.5 14.063a2 2 0 0 0-1.437 1.437l-1.582 6.135a.5.5 0 0 1-.963 0z" />
  </StrokeIcon>
);

export const WrenchIcon = (props: IconProps) => (
  <StrokeIcon {...props}>
    <path d="M14.7 6.3a1 1 0 0 0 0 1.4l1.6 1.6a1 1 0 0 0 1.4 0l3.77-3.77a6 6 0 0 1-7.94 7.94l-6.91 6.91a2.12 2.12 0 0 1-3-3l6.91-6.91a6 6 0 0 1 7.94-7.94l-3.76 3.76z" />
  </StrokeIcon>
);

export const ActivityIcon = (props: IconProps) => (
  <StrokeIcon {...props}>
    <path d="M22 12h-2.48a2 2 0 0 0-1.93 1.46l-2.35 8.36a.25.25 0 0 1-.48 0L9.24 2.18a.25.25 0 0 0-.48 0l-2.35 8.36A2 2 0 0 1 4.49 12H2" />
  </StrokeIcon>
);

export const LogOutIcon = (props: IconProps) => (
  <StrokeIcon {...props}>
    <path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4" />
    <path d="m16 17 5-5-5-5M21 12H9" />
  </StrokeIcon>
);

export const FolderIcon = (props: IconProps) => (
  <StrokeIcon {...props}>
    <path d="M20 20a2 2 0 0 0 2-2V8a2 2 0 0 0-2-2h-7.9a2 2 0 0 1-1.69-.9L9.6 3.9A2 2 0 0 0 7.93 3H4a2 2 0 0 0-2 2v13a2 2 0 0 0 2 2Z" />
  </StrokeIcon>
);

export const ShieldIcon = (props: IconProps) => (
  <StrokeIcon {...props}>
    <path d="M20 13c0 5-3.5 7.5-7.66 8.95a1 1 0 0 1-.67-.01C7.5 20.5 4 18 4 13V6a1 1 0 0 1 1-1c2 0 4.5-1.2 6.24-2.72a1.17 1.17 0 0 1 1.52 0C14.51 3.81 17 5 19 5a1 1 0 0 1 1 1z" />
  </StrokeIcon>
);

export const InboxIcon = (props: IconProps) => (
  <StrokeIcon {...props}>
    <path d="M22 12h-6l-2 3h-4l-2-3H2" />
    <path d="M5.45 5.11 2 12v6a2 2 0 0 0 2 2h16a2 2 0 0 0 2-2v-6l-3.45-6.89A2 2 0 0 0 16.76 4H7.24a2 2 0 0 0-1.79 1.11z" />
  </StrokeIcon>
);

export const SessionIcon = (props: IconProps) => (
  <StrokeIcon {...props}>
    <path d="M14 9a2 2 0 0 1-2 2H6l-4 4V4a2 2 0 0 1 2-2h8a2 2 0 0 1 2 2z" />
    <path d="M18 9h2a2 2 0 0 1 2 2v11l-4-4h-6a2 2 0 0 1-2-2v-1" />
  </StrokeIcon>
);

export const HashIcon = (props: IconProps) => (
  <StrokeIcon {...props}>
    <path d="M4 9h16M4 15h16M10 3 8 21M16 3l-2 18" />
  </StrokeIcon>
);

export const LogsIcon = (props: IconProps) => (
  <StrokeIcon {...props}>
    <path d="M4 6h1" />
    <path d="M9 6h11" />
    <path d="M4 12h1" />
    <path d="M9 12h11" />
    <path d="M4 18h1" />
    <path d="M9 18h11" />
  </StrokeIcon>
);

export const ChartIcon = (props: IconProps) => (
  <StrokeIcon {...props}>
    <path d="M3 3v16a2 2 0 0 0 2 2h16" />
    <path d="m7 15 4-5 4 3 5-7" />
  </StrokeIcon>
);

export const PromptIcon = (props: IconProps) => (
  <StrokeIcon {...props}>
    <path d="M15 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V7Z" />
    <path d="M14 2v4a2 2 0 0 0 2 2h4" />
    <path d="M10 9H8M16 13H8M16 17H8" />
  </StrokeIcon>
);

export const DatasetIcon = (props: IconProps) => (
  <StrokeIcon {...props}>
    <ellipse cx="12" cy="5" rx="8" ry="3" />
    <path d="M4 5v14c0 1.7 3.6 3 8 3s8-1.3 8-3V5" />
    <path d="M4 12c0 1.7 3.6 3 8 3s8-1.3 8-3" />
  </StrokeIcon>
);

export const RunIcon = (props: IconProps) => (
  <StrokeIcon {...props}>
    <path d="M6 4l14 8-14 8Z" />
  </StrokeIcon>
);

export const TargetIcon = (props: IconProps) => (
  <StrokeIcon {...props}>
    <circle cx="12" cy="12" r="10" />
    <circle cx="12" cy="12" r="6" />
    <circle cx="12" cy="12" r="2" />
  </StrokeIcon>
);

export const PlusIcon = (props: IconProps) => (
  <StrokeIcon {...props}>
    <path d="M5 12h14M12 5v14" />
  </StrokeIcon>
);

export const TagIcon = (props: IconProps) => (
  <StrokeIcon {...props}>
    <path d="M12.586 2.586A2 2 0 0 0 11.172 2H4a2 2 0 0 0-2 2v7.172a2 2 0 0 0 .586 1.414l8.704 8.704a2.426 2.426 0 0 0 3.42 0l6.58-6.58a2.426 2.426 0 0 0 0-3.42z" />
    <circle cx="7.5" cy="7.5" r=".5" fill="currentColor" />
  </StrokeIcon>
);

export const CompareIcon = (props: IconProps) => (
  <StrokeIcon {...props}>
    <circle cx="18" cy="18" r="3" />
    <circle cx="6" cy="6" r="3" />
    <path d="M13 6h3a2 2 0 0 1 2 2v7M11 18H8a2 2 0 0 1-2-2V9" />
  </StrokeIcon>
);

export const ArrowLeftIcon = (props: IconProps) => (
  <StrokeIcon {...props}>
    <path d="m12 19-7-7 7-7M19 12H5" />
  </StrokeIcon>
);

export const SwapIcon = (props: IconProps) => (
  <StrokeIcon {...props}>
    <path d="M8 3 4 7l4 4M4 7h16M16 21l4-4-4-4M20 17H4" />
  </StrokeIcon>
);

export const TrashIcon = (props: IconProps) => (
  <StrokeIcon {...props}>
    <path d="M3 6h18M19 6v14c0 1-1 2-2 2H7c-1 0-2-1-2-2V6M8 6V4c0-1 1-2 2-2h4c1 0 2 1 2 2v2" />
  </StrokeIcon>
);

/** The Extispex mark: an eye looking into a trace. */
export function BrandMark({ size = 24 }: { size?: number }) {
  return (
    <svg
      className="brand-mark"
      width={size}
      height={size}
      viewBox="0 0 32 32"
      aria-hidden="true"
      focusable="false"
    >
      <rect width="32" height="32" rx="8" fill="var(--color-brand)" />
      <path
        d="M5.5 16c2.6-4.6 6.1-7 10.5-7s7.9 2.4 10.5 7c-2.6 4.6-6.1 7-10.5 7s-7.9-2.4-10.5-7Z"
        fill="none"
        stroke="#fff"
        strokeWidth="2.2"
        strokeLinejoin="round"
      />
      <circle cx="16" cy="16" r="3.6" fill="#fff" />
      <path d="M14.4 16h3.2" stroke="var(--color-brand)" strokeWidth="1.6" strokeLinecap="round" />
    </svg>
  );
}
