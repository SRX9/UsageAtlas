"use client"

import { polarX, polarY } from "./polar"
import { usePolarChart } from "./polar-context"

const LEVELS = 4

/** Concentric polygon rings, spokes, and axis labels behind the radar canvas. */
export function RadarFrame() {
  const ctx = usePolarChart()
  if (!ctx.ready || !ctx.radar) return null
  const { axes } = ctx.radar
  const { x: centerX, y: centerY } = ctx.center
  const radius = ctx.outerRadius

  const ring = (ringRadius: number) =>
    `${axes
      .map(
        (axis, index) =>
          `${index === 0 ? "M" : "L"}${polarX(centerX, ringRadius, axis.angle).toFixed(1)},${polarY(centerY, ringRadius, axis.angle).toFixed(1)}`
      )
      .join(" ")} Z`

  return (
    <g>
      <g className="stroke-border" fill="none">
        {Array.from({ length: LEVELS }, (_, level) => (
          <path key={level} d={ring((radius * (level + 1)) / LEVELS)} />
        ))}
        {axes.map((axis, index) => (
          <line
            key={axis.label}
            x1={centerX}
            y1={centerY}
            x2={polarX(centerX, radius, axis.angle)}
            y2={polarY(centerY, radius, axis.angle)}
            className={
              ctx.hoverIndex === index ? "stroke-foreground" : undefined
            }
          />
        ))}
      </g>
      <g className="font-mono text-[10px]">
        {axes.map((axis, index) => {
          const labelX = polarX(centerX, radius + 10, axis.angle)
          const labelY = polarY(centerY, radius + 10, axis.angle)
          const anchor =
            Math.abs(Math.cos(axis.angle)) < 0.3
              ? "middle"
              : Math.cos(axis.angle) > 0
                ? "start"
                : "end"
          const highlighted = ctx.hoverIndex === index
          return (
            <text
              key={axis.label}
              x={labelX}
              y={labelY}
              textAnchor={anchor}
              dominantBaseline="central"
              className={
                highlighted ? "fill-foreground" : "fill-muted-foreground"
              }
            >
              {axis.label}
            </text>
          )
        })}
      </g>
    </g>
  )
}

RadarFrame.chartLayer = "back" as const
