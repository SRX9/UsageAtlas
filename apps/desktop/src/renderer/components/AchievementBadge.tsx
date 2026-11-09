import { useId, type ComponentProps, type ReactNode } from "react";
import type { AchievementId } from "../achievements";

// Illustrated achievement badges. Public profiles draw the same ones
// (`cloud/apps/web/app/profile/achievement-badge.tsx`). Keep the two the same.

type Point = [number, number];

const num = (value: number) => Math.round(value * 100) / 100;
const polar = (radius: number, degrees: number): Point =>
  [32 + radius * Math.cos((degrees * Math.PI) / 180), 32 + radius * Math.sin((degrees * Math.PI) / 180)];

/** A closed path through `points` with each corner rounded off. */
function rounded(points: Point[], radius: number): string {
  return points.map(([x, y], index) => {
    const toward = ([tx, ty]: Point) => {
      const share = Math.min(radius, Math.hypot(tx - x, ty - y) / 2) / Math.hypot(tx - x, ty - y);
      return `${num(x + (tx - x) * share)} ${num(y + (ty - y) * share)}`;
    };
    return `${index ? "L" : "M"}${toward(points.at(index - 1)!)}Q${num(x)} ${num(y)} ${toward(points[(index + 1) % points.length])}`;
  }).join("") + "Z";
}

const circle = (radius: number) => `M32 ${32 - radius}a${radius} ${radius} 0 1 1 0 ${radius * 2}a${radius} ${radius} 0 1 1 0 ${-radius * 2}Z`;
const hexagon = (radius: number) => rounded([0, 1, 2, 3, 4, 5].map((index) => polar(radius, index * 60 - 90)), radius / 6);
const gear = rounded(Array.from({ length: 8 }, (_, tooth) => [
  polar(25.5, tooth * 45 - 13), polar(30.5, tooth * 45 - 7), polar(30.5, tooth * 45 + 7), polar(25.5, tooth * 45 + 13)
]).flat(), 2.2);
const rosette = (() => {
  const points = Array.from({ length: 12 }, (_, index) => polar(26.5, index * 30 - 90));
  return `M${points[0].map(num).join(" ")}` + points.map((_, index) => `A7.2 7.2 0 0 1 ${points[(index + 1) % 12].map(num).join(" ")}`).join("") + "Z";
})();
const shield = "M32 2.5C38 5.5 46 8 54 9C56 9.3 57 10.5 57 12.5V29C57 45 46.5 55.5 32 61.5C17.5 55.5 7 45 7 29V12.5C7 10.5 8 9.3 10 9C18 8 26 5.5 32 2.5Z";
/** Four-point star. */
const sparkle = (x: number, y: number, size: number) =>
  `M${x} ${y - size}Q${x} ${y} ${x + size} ${y}Q${x} ${y} ${x} ${y + size}Q${x} ${y} ${x - size} ${y}Q${x} ${y} ${x} ${y - size}Z`;
/** The reeded edge of a coin. */
const reeds = Array.from({ length: 40 }, (_, index) => {
  const [x1, y1] = polar(27.6, index * 9), [x2, y2] = polar(30, index * 9);
  return `M${num(x1)} ${num(y1)}L${num(x2)} ${num(y2)}`;
}).join("");

interface Design {
  /** The rim's outline. */
  shape: string;
  /** The face inside the rim. */
  face: string;
  /** Top and bottom of the face. */
  colors: [string, string];
  art: ReactNode;
}

const DESIGNS: Record<AchievementId, Design> = {
  tokens: {
    shape: circle(30.5),
    face: circle(25.5),
    colors: ["#a78bfa", "#4c1d95"],
    art: <>
      <path d={sparkle(18, 21, 4)} fill="#fff" />
      <path d={sparkle(46.5, 45, 3)} fill="#fff" opacity={0.85} />
      <circle cx={46} cy={19} r={1.4} fill="#fff" opacity={0.7} />
      <path d="M36.5 10 19 35.5H30L26.5 54 45 27.5H34Z" fill="#facc15" stroke="#854d0e" strokeLinejoin="round" strokeWidth={1.4} />
      <path d="M36.5 10 19 35.5H30Z" fill="#fef08a" />
    </>
  },
  streak: {
    shape: hexagon(30.5),
    face: hexagon(25.5),
    colors: ["#fff7ed", "#fdba74"],
    art: <>
      <circle cx={21} cy={20} r={1.5} fill="#f97316" />
      <circle cx={44.5} cy={17} r={1.2} fill="#fb923c" />
      <circle cx={46} cy={26} r={1} fill="#f97316" />
      <path d="M32 9C33 17 41 21 43.5 30C46.5 40.5 40.5 52 32 52C23.5 52 17.5 45 19 36C20 30 23.5 27.5 25 22.5C27.5 26 28 29.5 29 31C30.5 24 29.5 16 32 9Z" fill="#ef4444" />
      <path d="M32.5 22C34.5 29 40 32 40 40.5C40 46.5 36.5 50.5 32 50.5C27.5 50.5 24 46.5 24.5 41.5C25 37.5 27.5 36 28.5 32.5C30 35 30.5 36.5 31.5 37C32.5 32 31 27 32.5 22Z" fill="#f97316" />
      <path d="M32.5 35C34.5 39 37 41 37 44.5C37 47.6 34.8 49.5 32 49.5C29.2 49.5 27 47.5 27.4 44.6C27.8 41.5 31.2 39.5 32.5 35Z" fill="#fde047" />
    </>
  },
  "active-days": {
    shape: shield,
    face: "M32 8C37 10.5 43.5 12.5 51 13.5V29C51 41.5 43 49.5 32 54.5C21 49.5 13 41.5 13 29V13.5C20.5 12.5 27 10.5 32 8Z",
    colors: ["#99f6e4", "#0d9488"],
    art: <>
      <rect x={18} y={19} width={28} height={27} rx={4.5} fill="#fff" />
      <path d="M18 23.5A4.5 4.5 0 0 1 22.5 19H41.5A4.5 4.5 0 0 1 46 23.5V27H18Z" fill="#ef4444" />
      <rect x={23} y={15.5} width={3.5} height={7.5} rx={1.75} fill="#334155" />
      <rect x={37.5} y={15.5} width={3.5} height={7.5} rx={1.75} fill="#334155" />
      <path d="M25 36.5 30 41.5 39.5 31.5" fill="none" stroke="#0d9488" strokeLinecap="round" strokeLinejoin="round" strokeWidth={4} />
    </>
  },
  "big-day": {
    shape: rosette,
    face: circle(23),
    colors: ["#4338ca", "#1e1b4b"],
    art: <>
      <path d={sparkle(20, 22, 3)} fill="#fff" />
      <path d={sparkle(44, 44, 2.4)} fill="#fde68a" />
      <circle cx={22} cy={44} r={1.2} fill="#fff" opacity={0.8} />
      <circle cx={45} cy={22} r={1} fill="#fff" opacity={0.8} />
      <g transform="translate(32.5 31.5) rotate(45) scale(0.92)">
        <path d="M-4.5 10Q0 24 4.5 10Z" fill="#fb923c" />
        <path d="M-2.2 10Q0 18 2.2 10Z" fill="#fde047" />
        <path d="M-5 1-10.5 9.5V12.5L-5.5 9.5ZM5 1 10.5 9.5V12.5L5.5 9.5Z" fill="#ef4444" />
        <path d="M0-16C6-11 7-3 6 10H-6C-7-3-6-11 0-16Z" fill="#f1f5f9" />
        <path d="M0-16C6-11 7-3 6 10H2.5C3.5-2 3-10 0-16Z" fill="#cbd5e1" />
        <path d="M0-16C3.4-13.2 4.9-10.5 5.6-8H-5.6C-4.9-10.5-3.4-13.2 0-16Z" fill="#ef4444" />
        <circle cy={-1.5} r={3.2} fill="#38bdf8" stroke="#334155" strokeWidth={1.4} />
        <rect x={-1} y={4} width={2} height={8} rx={1} fill="#b91c1c" />
      </g>
    </>
  },
  tools: {
    shape: gear,
    face: circle(21.5),
    colors: ["#bfdbfe", "#2563eb"],
    art: <>
      <g transform="translate(32 32) rotate(-45)">
        <rect x={-2.4} y={-10} width={4.8} height={28} rx={2.4} fill="#f59e0b" stroke="#92400e" strokeWidth={1.2} />
        <rect x={-9.5} y={-17} width={19} height={8.5} rx={2} fill="#64748b" stroke="#334155" strokeWidth={1.2} />
        <rect x={-8.5} y={-16} width={17} height={2.5} rx={1.25} fill="#94a3b8" />
      </g>
      <path transform="translate(32 32) rotate(45)" d="M-2.6-17.5V-12A2.6 2.6 0 0 0 2.6-12V-17.5A7 7 0 0 1 2.6-4.5V16A2.6 2.6 0 0 1-2.6 16V-4.5A7 7 0 0 1-2.6-17.5Z" fill="#e2e8f0" stroke="#475569" strokeLinejoin="round" strokeWidth={1.3} />
    </>
  }
};

/** Rim colors, light to dark, for each tier from the first. */
const RIMS = [
  ["#f8d7b4", "#d08a52", "#8a4b22"],
  ["#ffffff", "#cfd5dd", "#7d8899"],
  ["#fff6c2", "#f5c542", "#a67a06"],
  ["#f0fbff", "#a5d8f0", "#4b86ab"],
  ["#fae8ff", "#d38cf5", "#7e3aad"],
  ["#ffd1e8", "#ffe7a3", "#b6f2d0", "#a9d4ff", "#c9b2ff", "#7c6fb0"]
];
const LOCKED = ["#f3f4f6", "#c4c9d0", "#8b929c"];

/** A family's badge, its rim set by the tier reached. Level 0 draws a plain rim. */
export function AchievementBadge({ id, level, ...props }: { id: AchievementId; level: number } & ComponentProps<"svg">): React.JSX.Element {
  const design = DESIGNS[id];
  const rim = RIMS[Math.min(level, RIMS.length) - 1] ?? LOCKED;
  const uid = useId();
  return <svg aria-hidden="true" viewBox="0 0 64 64" {...props}>
    <defs>
      <linearGradient id={uid + "rim"} x1="0" y1="0" x2="1" y2="1">
        {rim.map((color, index) => <stop key={index} offset={index / (rim.length - 1)} stopColor={color} />)}
      </linearGradient>
      <linearGradient id={uid + "face"} x1="0" y1="0" x2="0" y2="1">
        <stop offset="0" stopColor={design.colors[0]} />
        <stop offset="1" stopColor={design.colors[1]} />
      </linearGradient>
      <clipPath id={uid + "clip"}><path d={design.face} /></clipPath>
    </defs>
    <path d={design.shape} fill={`url(#${uid}rim)`} stroke={rim.at(-1)} strokeWidth={1} />
    {id === "tokens" && <path d={reeds} stroke={rim.at(-1)} strokeOpacity={0.35} strokeWidth={0.8} />}
    <path d={design.face} fill={`url(#${uid}face)`} stroke={rim.at(-1)} strokeWidth={1.2} />
    <ellipse clipPath={`url(#${uid}clip)`} cx={24} cy={14} rx={26} ry={13} fill="#fff" opacity={0.18} />
    {design.art}
  </svg>;
}
