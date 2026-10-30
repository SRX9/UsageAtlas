import type { SVGProps } from "react";

type IconProps = SVGProps<SVGSVGElement>;

function IconBase({ children, ...props }: IconProps): React.JSX.Element {
  return (
    <svg
      aria-hidden="true"
      fill="none"
      height="20"
      stroke="currentColor"
      strokeLinecap="round"
      strokeLinejoin="round"
      strokeWidth="1.8"
      viewBox="0 0 24 24"
      width="20"
      {...props}
    >
      {children}
    </svg>
  );
}

export function DayIcon(props: IconProps): React.JSX.Element {
  return (
    <IconBase {...props}>
      <rect height="16" rx="3" width="16" x="4" y="5" />
      <path d="M8 3v4m8-4v4M4 9h16m-12 4h3m2 0h3m-8 4h3" />
    </IconBase>
  );
}

export function HistoryIcon(props: IconProps): React.JSX.Element {
  return (
    <IconBase {...props}>
      <path d="M4 12a8 8 0 1 0 2.3-5.7L4 8.6" />
      <path d="M4 4v4.6h4.6M12 8v4l2.8 1.8" />
    </IconBase>
  );
}

export function CalendarRangeIcon(props: IconProps): React.JSX.Element {
  return (
    <IconBase {...props}>
      <rect height="16" rx="3" width="16" x="4" y="5" />
      <path d="M8 3v4m8-4v4M4 9h16M8 13h3m2 4h3" />
    </IconBase>
  );
}

export function TrendsIcon(props: IconProps): React.JSX.Element {
  return <IconBase {...props}><path d="M4 18 9 12l4 3 7-9M16 6h4v4" /></IconBase>;
}

export function InsightsIcon(props: IconProps): React.JSX.Element {
  return (
    <IconBase {...props}>
      <path d="M5 19V13M12 19V5M19 19V9" />
      <path d="M3 19h18" />
    </IconBase>
  );
}

export function ProvidersIcon(props: IconProps): React.JSX.Element {
  return (
    <IconBase {...props}>
      <rect height="6" rx="2" width="6" x="3" y="4" />
      <rect height="6" rx="2" width="6" x="15" y="4" />
      <rect height="6" rx="2" width="6" x="9" y="14" />
      <path d="M6 10v2h12v-2m-6 2v2" />
    </IconBase>
  );
}

export function ChevronLeftIcon(props: IconProps): React.JSX.Element {
  return <IconBase {...props}><path d="m15 18-6-6 6-6" /></IconBase>;
}

export function ChevronRightIcon(props: IconProps): React.JSX.Element {
  return <IconBase {...props}><path d="m9 18 6-6-6-6" /></IconBase>;
}

export function ChevronDownIcon(props: IconProps): React.JSX.Element {
  return <IconBase {...props}><path d="m7 10 5 5 5-5" /></IconBase>;
}

export function SettingsIcon(props: IconProps): React.JSX.Element {
  return (
    <IconBase {...props}>
      <path d="M12 15.2a3.2 3.2 0 1 0 0-6.4 3.2 3.2 0 0 0 0 6.4Z" />
      <path d="m19 13.8 1.4 1.1-2 3.5-1.7-.7a8 8 0 0 1-2.4 1.4L14 21h-4l-.3-1.9a8 8 0 0 1-2.4-1.4l-1.7.7-2-3.5L5 13.8a8 8 0 0 1 0-2.8L3.6 9.9l2-3.5 1.7.7a8 8 0 0 1 2.4-1.4L10 4h4l.3 1.7a8 8 0 0 1 2.4 1.4l1.7-.7 2 3.5L19 11a8 8 0 0 1 0 2.8Z" />
    </IconBase>
  );
}

export function PulseIcon(props: IconProps): React.JSX.Element {
  return <IconBase {...props}><path d="M3 12h4l2-6 4 12 2-6h6" /></IconBase>;
}

export function RefreshIcon(props: IconProps): React.JSX.Element {
  return (
    <IconBase {...props}>
      <path d="M20 7v5h-5" />
      <path d="M19 12a7 7 0 1 0-2 5" />
    </IconBase>
  );
}

export function DownloadIcon(props: IconProps): React.JSX.Element {
  return <IconBase {...props}><path d="M12 3v12m-4-4 4 4 4-4M5 16v4h14v-4" /></IconBase>;
}

export function MoonIcon(props: IconProps): React.JSX.Element {
  return <IconBase {...props}><path d="M20 15.2A8.5 8.5 0 0 1 8.8 4 8.5 8.5 0 1 0 20 15.2Z" /></IconBase>;
}

export function SunIcon(props: IconProps): React.JSX.Element {
  return (
    <IconBase {...props}>
      <circle cx="12" cy="12" r="4" />
      <path d="M12 2v2m0 16v2M2 12h2m16 0h2M4.9 4.9l1.4 1.4m11.4 11.4 1.4 1.4m0-14.2-1.4 1.4M6.3 17.7l-1.4 1.4" />
    </IconBase>
  );
}

export function ExternalIcon(props: IconProps): React.JSX.Element {
  return <IconBase {...props}><path d="M14 5h5v5m0-5-8 8M19 14v5H5V5h5" /></IconBase>;
}

export function CheckIcon(props: IconProps): React.JSX.Element {
  return <IconBase {...props}><path d="m5 12 4 4L19 6" /></IconBase>;
}

export function CloseIcon(props: IconProps): React.JSX.Element {
  return <IconBase {...props}><path d="M6 6l12 12M18 6 6 18" /></IconBase>;
}

export function AlertIcon(props: IconProps): React.JSX.Element {
  return (
    <IconBase {...props}>
      <path d="M12 3 2.8 20h18.4L12 3Z" />
      <path d="M12 9v4m0 3h.01" />
    </IconBase>
  );
}
export function BellIcon(props: IconProps): React.JSX.Element {
  return (
    <IconBase {...props}>
      <path d="M18 8a6 6 0 0 0-12 0c0 7-3 7-3 9h18c0-2-3-2-3-9" />
      <path d="M10 21h4" />
    </IconBase>
  );
}
export function ShareIcon(props: IconProps): React.JSX.Element {
  return <IconBase {...props}><path d="M12 15V3m-4 4 4-4 4 4" /><path d="M5 12v7a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2v-7" /></IconBase>;
}

export function ProfileIcon(props: IconProps): React.JSX.Element {
  return (
    <IconBase {...props}>
      <circle cx="12" cy="9" r="3.5" />
      <path d="M5.5 19.5a7 7 0 0 1 13 0" />
      <rect height="18" rx="4" width="18" x="3" y="3" />
    </IconBase>
  );
}

export function ZapIcon(props: IconProps): React.JSX.Element {
  return <IconBase {...props}><path d="M4 14a1 1 0 0 1-.78-1.63l9.9-10.2a.5.5 0 0 1 .86.46l-1.92 6.02A1 1 0 0 0 13 10h7a1 1 0 0 1 .78 1.63l-9.9 10.2a.5.5 0 0 1-.86-.46l1.92-6.02A1 1 0 0 0 11 14z" /></IconBase>;
}

export function FlameIcon(props: IconProps): React.JSX.Element {
  return <IconBase {...props}><path d="M8.5 14.5A2.5 2.5 0 0 0 11 12c0-1.38-.5-2-1-3-1.07-2.14-.22-4.05 2-6 .5 2.5 2 4.9 4 6.5 2 1.6 3 3.5 3 5.5a7 7 0 1 1-14 0c0-1.15.43-2.29 1-3a2.5 2.5 0 0 0 2.5 2.5z" /></IconBase>;
}

export function CalendarCheckIcon(props: IconProps): React.JSX.Element {
  return <IconBase {...props}><rect height="18" rx="2" width="18" x="3" y="4" /><path d="M8 2v4m8-4v4M3 10h18m-12 6 2 2 4-4" /></IconBase>;
}

export function RocketIcon(props: IconProps): React.JSX.Element {
  return (
    <IconBase {...props}>
      <path d="M4.5 16.5c-1.5 1.26-2 5-2 5s3.74-.5 5-2c.71-.84.7-2.13-.09-2.91a2.18 2.18 0 0 0-2.91-.09z" />
      <path d="m12 15-3-3a22 22 0 0 1 2-3.95A12.88 12.88 0 0 1 22 2c0 2.72-.78 7.5-6 11a22.35 22.35 0 0 1-4 2z" />
      <path d="M9 12H4s.55-3.03 2-4c1.62-1.08 5 0 5 0m1 7v5s3.03-.55 4-2c1.08-1.62 0-5 0-5" />
    </IconBase>
  );
}

export function WrenchIcon(props: IconProps): React.JSX.Element {
  return <IconBase {...props}><path d="M14.7 6.3a1 1 0 0 0 0 1.4l1.6 1.6a1 1 0 0 0 1.4 0l3.77-3.77a6 6 0 0 1-7.94 7.94l-6.91 6.91a2.12 2.12 0 0 1-3-3l6.91-6.91a6 6 0 0 1 7.94-7.94l-3.76 3.76z" /></IconBase>;
}

export function AttributionIcon(props: IconProps): React.JSX.Element {
  return (
    <IconBase {...props}>
      <rect height="5" rx="1.5" width="6" x="3" y="4" />
      <rect height="5" rx="1.5" width="6" x="15" y="15" />
      <path d="M9 6.5h5.5A3.5 3.5 0 0 1 18 10v3.5" />
      <path d="m16 11.5 2 2 2-2" />
      <path d="M15 17.5H9.5A3.5 3.5 0 0 1 6 14v-3.5" />
      <path d="m4 12.5 2-2 2 2" />
    </IconBase>
  );
}

export function GiftIcon(props: IconProps): React.JSX.Element {
  return (
    <IconBase {...props}>
      <rect height="4" rx="1" width="18" x="3" y="8" />
      <path d="M12 8v13m7-9v7a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2v-7" />
      <path d="M7.5 8a2.5 2.5 0 0 1 0-5A4.8 8 0 0 1 12 8a4.8 8 0 0 1 4.5-5 2.5 2.5 0 0 1 0 5" />
    </IconBase>
  );
}
