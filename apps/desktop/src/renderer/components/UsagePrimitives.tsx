/* eslint-disable react-refresh/only-export-components -- Compound components expose named parts through Object.assign. */

import clsx from "clsx";
import type { HTMLAttributes, ReactNode } from "react";

type KPIProps = HTMLAttributes<HTMLElement>;
type KPIHeaderProps = HTMLAttributes<HTMLDivElement>;
type KPIContentProps = HTMLAttributes<HTMLDivElement>;
type KPITitleProps = HTMLAttributes<HTMLHeadingElement>;

function KPIRoot({ className, ...props }: KPIProps): React.JSX.Element {
  return <section className={clsx("usage-kpi", className)} {...props} />;
}

function KPIHeader({ className, ...props }: KPIHeaderProps): React.JSX.Element {
  return <div className={clsx("usage-kpi__header", className)} {...props} />;
}

function KPIContent({ className, ...props }: KPIContentProps): React.JSX.Element {
  return <div className={clsx("usage-kpi__content", className)} {...props} />;
}

function KPITitle({ className, ...props }: KPITitleProps): React.JSX.Element {
  return <h2 className={clsx("usage-kpi__title", className)} {...props} />;
}

export const KPI = Object.assign(KPIRoot, {
  Content: KPIContent,
  Header: KPIHeader,
  Title: KPITitle
});

type Trend = "up" | "down" | "neutral";
type TrendSize = "sm" | "md" | "lg";
type TrendVariant = "primary" | "secondary" | "soft" | "tertiary";

interface TrendChipProps extends Omit<HTMLAttributes<HTMLSpanElement>, "color"> {
  children: ReactNode;
  size?: TrendSize;
  trend?: Trend;
  variant?: TrendVariant;
}

function TrendChipRoot({
  children,
  className,
  size = "sm",
  trend = "up",
  variant = "soft",
  ...props
}: TrendChipProps): React.JSX.Element {
  return (
    <span
      className={clsx("usage-trend-chip", className)}
      data-size={size}
      data-trend={trend}
      data-variant={variant}
      {...props}
    >
      <TrendDirectionIcon trend={trend} />
      <span className="usage-trend-chip__value">{children}</span>
    </span>
  );
}

function TrendChipPrefix({ className, ...props }: HTMLAttributes<HTMLSpanElement>): React.JSX.Element {
  return <span className={clsx("usage-trend-chip__prefix", className)} {...props} />;
}

function TrendChipSuffix({ className, ...props }: HTMLAttributes<HTMLSpanElement>): React.JSX.Element {
  return <span className={clsx("usage-trend-chip__suffix", className)} {...props} />;
}

function TrendDirectionIcon({ trend }: { trend: Trend }): React.JSX.Element {
  if (trend === "neutral") {
    return (
      <svg aria-hidden="true" className="usage-trend-chip__indicator" viewBox="0 0 12 12">
        <path d="M2.5 6h7" />
      </svg>
    );
  }

  return (
    <svg
      aria-hidden="true"
      className="usage-trend-chip__indicator"
      data-direction={trend}
      viewBox="0 0 12 12"
    >
      <path d="M3 9 9 3M4.5 3H9v4.5" />
    </svg>
  );
}

export const TrendChip = Object.assign(TrendChipRoot, {
  Prefix: TrendChipPrefix,
  Suffix: TrendChipSuffix
});

type EmptyStateSize = "sm" | "md" | "lg";
type EmptyStateMediaVariant = "default" | "icon";

interface EmptyStateProps extends HTMLAttributes<HTMLDivElement> {
  size?: EmptyStateSize;
}

interface EmptyStateMediaProps extends HTMLAttributes<HTMLDivElement> {
  variant?: EmptyStateMediaVariant;
}

function EmptyStateRoot({ className, size = "md", ...props }: EmptyStateProps): React.JSX.Element {
  return <div className={clsx("usage-empty-state", className)} data-size={size} {...props} />;
}

function EmptyStateHeader({ className, ...props }: HTMLAttributes<HTMLDivElement>): React.JSX.Element {
  return <div className={clsx("usage-empty-state__header", className)} {...props} />;
}

function EmptyStateMedia({
  className,
  variant = "default",
  ...props
}: EmptyStateMediaProps): React.JSX.Element {
  return (
    <div
      aria-hidden="true"
      className={clsx("usage-empty-state__media", className)}
      data-variant={variant}
      {...props}
    />
  );
}

function EmptyStateTitle({ className, ...props }: HTMLAttributes<HTMLHeadingElement>): React.JSX.Element {
  return <h2 className={clsx("usage-empty-state__title", className)} {...props} />;
}

function EmptyStateDescription({ className, ...props }: HTMLAttributes<HTMLParagraphElement>): React.JSX.Element {
  return <p className={clsx("usage-empty-state__description", className)} {...props} />;
}

function EmptyStateContent({ className, ...props }: HTMLAttributes<HTMLDivElement>): React.JSX.Element {
  return <div className={clsx("usage-empty-state__content", className)} {...props} />;
}

export const EmptyState = Object.assign(EmptyStateRoot, {
  Content: EmptyStateContent,
  Description: EmptyStateDescription,
  Header: EmptyStateHeader,
  Media: EmptyStateMedia,
  Title: EmptyStateTitle
});
