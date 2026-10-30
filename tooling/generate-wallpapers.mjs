import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";

/**
 * Generates the bundled 4K wallpapers as SVG. A vector background is exactly as
 * sharp on a 1080p panel as on a 4K one, weighs a few kilobytes instead of
 * megabytes, and keeps the same layered-gradient look as the original set.
 */
const WIDTH = 3840;
const HEIGHT = 2160;
const OUT = path.join(import.meta.dirname, "..", "apps", "desktop", "src", "renderer", "assets");

const wallpapers = [
  {
    id: "sierra",
    sky: ["#f7e7d3", "#f3c9a8", "#c98a86", "#4c4a6b"],
    glow: "#ffe4bd",
    layers: ["#5b5a86", "#494970", "#383858", "#292a44", "#1b1c30"],
    horizon: 0.52
  },
  {
    id: "aurora",
    sky: ["#07131f", "#0b2434", "#123b46", "#08131c"],
    glow: "#4fe0c0",
    layers: ["#123b46", "#0d3039", "#0a252d", "#071a21", "#041016"],
    horizon: 0.6,
    ribbons: true
  },
  {
    id: "dunes",
    sky: ["#fde7cf", "#f7c497", "#e79a6c", "#8c5a51"],
    glow: "#ffd9a8",
    layers: ["#d99263", "#bd754f", "#9c5b41", "#784232", "#4c2a24"],
    horizon: 0.58
  },
  {
    id: "tide",
    sky: ["#dff3f4", "#b7e2e6", "#7fb9c9", "#2f5f7d"],
    glow: "#e8ffff",
    layers: ["#5fa5b7", "#4a8ea3", "#37748b", "#255a71", "#173d52"],
    horizon: 0.54
  },
  {
    id: "orchid",
    sky: ["#fbe6f6", "#efb9e3", "#c47bd1", "#4b2a63"],
    glow: "#ffd9f4",
    layers: ["#9b63b5", "#84519f", "#693d84", "#4e2b66", "#331a46"],
    horizon: 0.5
  },
  {
    id: "solstice",
    sky: ["#ffe9c9", "#ffb37a", "#f2707a", "#5a2a5c"],
    glow: "#fff0c4",
    layers: ["#b7486a", "#97385c", "#762a4b", "#54203a", "#321226"],
    horizon: 0.56
  }
];

function ridge(y, amplitude, phase, bias) {
  // A broad primary swell with a faint secondary one reads as a mountain range;
  // a high-frequency term turned the silhouettes into scalloped paper. The
  // points are generous because the SVG is displayed at 4K.
  const points = [];
  const steps = 96;
  for (let index = 0; index <= steps; index += 1) {
    const t = index / steps;
    const wave = Math.sin(t * Math.PI * 1.7 + phase) * amplitude
      + Math.sin(t * Math.PI * 3.1 + phase * 1.35) * amplitude * 0.16;
    const x = WIDTH * t;
    points.push(`${x.toFixed(0)},${(y + wave + bias).toFixed(0)}`);
  }
  return `M0,${HEIGHT} L0,${y + bias} L${points.join(" L")} L${WIDTH},${HEIGHT} Z`;
}

function svg(wallpaper) {
  const [top, mid, low, deep] = wallpaper.sky;
  const glowY = HEIGHT * wallpaper.horizon;
  const layers = wallpaper.layers.map((color, index) => {
    const y = glowY + index * (HEIGHT - glowY) * 0.2 - 60;
    const amplitude = 86 - index * 7;
    return `<path d="${ridge(y, amplitude, index * 1.3, 0)}" fill="url(#layer${index})"/>`;
  }).join("\n    ");
  const ribbons = wallpaper.ribbons
    ? `<g opacity="0.9" filter="url(#soft)">
      <path d="M-200,760 C700,420 1400,980 2300,620 C3000,330 3560,640 4040,460 L4040,900 C3400,1040 2900,760 2200,940 C1400,1150 780,760 -200,1040 Z" fill="url(#ribbonA)"/>
      <path d="M-200,1050 C600,780 1300,1200 2200,950 C3000,740 3480,980 4040,820 L4040,1110 C3300,1270 2800,1050 2100,1170 C1300,1310 700,1050 -200,1270 Z" fill="url(#ribbonB)"/>
    </g>`
    : "";
  const layerDefs = wallpaper.layers.map((color, index) => {
    const next = wallpaper.layers[Math.min(wallpaper.layers.length - 1, index + 1)];
    return `<linearGradient id="layer${index}" x1="0" y1="0" x2="0" y2="1">
      <stop offset="0" stop-color="${color}" stop-opacity="0.96"/>
      <stop offset="1" stop-color="${next}" stop-opacity="1"/>
    </linearGradient>`;
  }).join("\n    ");
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${WIDTH}" height="${HEIGHT}" viewBox="0 0 ${WIDTH} ${HEIGHT}" role="img" aria-label="UsageAtlas ${wallpaper.id} wallpaper">
  <defs>
    <linearGradient id="sky" x1="0" y1="0" x2="0.35" y2="1">
      <stop offset="0" stop-color="${top}"/>
      <stop offset="0.42" stop-color="${mid}"/>
      <stop offset="0.78" stop-color="${low}"/>
      <stop offset="1" stop-color="${deep}"/>
    </linearGradient>
    <radialGradient id="glow" cx="0.5" cy="0.5" r="0.5">
      <stop offset="0" stop-color="${wallpaper.glow}" stop-opacity="0.85"/>
      <stop offset="0.55" stop-color="${wallpaper.glow}" stop-opacity="0.28"/>
      <stop offset="1" stop-color="${wallpaper.glow}" stop-opacity="0"/>
    </radialGradient>
    ${layerDefs}
    <linearGradient id="ribbonA" x1="0" y1="0" x2="1" y2="0.4">
      <stop offset="0" stop-color="#58ffd0" stop-opacity="0.05"/>
      <stop offset="0.45" stop-color="#58ffd0" stop-opacity="0.5"/>
      <stop offset="1" stop-color="#8f7dff" stop-opacity="0.05"/>
    </linearGradient>
    <linearGradient id="ribbonB" x1="0" y1="0" x2="1" y2="0.2">
      <stop offset="0" stop-color="#7d8cff" stop-opacity="0.04"/>
      <stop offset="0.5" stop-color="#7d8cff" stop-opacity="0.42"/>
      <stop offset="1" stop-color="#58ffd0" stop-opacity="0.04"/>
    </linearGradient>
    <filter id="soft" x="-10%" y="-30%" width="120%" height="160%">
      <feGaussianBlur stdDeviation="70"/>
    </filter>
    <filter id="haze" x="-10%" y="-40%" width="120%" height="180%">
      <feGaussianBlur stdDeviation="120"/>
    </filter>
  </defs>
  <rect width="${WIDTH}" height="${HEIGHT}" fill="url(#sky)"/>
  <ellipse cx="${WIDTH * 0.52}" cy="${glowY}" rx="${WIDTH * 0.46}" ry="${HEIGHT * 0.34}" fill="url(#glow)"/>
  <g filter="url(#haze)" opacity="0.55">
    <ellipse cx="${WIDTH * 0.3}" cy="${HEIGHT * 0.34}" rx="${WIDTH * 0.34}" ry="${HEIGHT * 0.12}" fill="${wallpaper.glow}" opacity="0.5"/>
    <ellipse cx="${WIDTH * 0.74}" cy="${HEIGHT * 0.44}" rx="${WIDTH * 0.4}" ry="${HEIGHT * 0.1}" fill="${wallpaper.glow}" opacity="0.32"/>
  </g>
  ${ribbons}
  <g>
    ${layers}
  </g>
  <rect width="${WIDTH}" height="${HEIGHT}" fill="url(#sky)" opacity="0.06"/>
</svg>
`;
}

mkdirSync(OUT, { recursive: true });
for (const wallpaper of wallpapers) {
  const file = path.join(OUT, `wallpaper-${wallpaper.id}.svg`);
  writeFileSync(file, svg(wallpaper), "utf8");
  console.log(`wrote ${path.relative(process.cwd(), file)}`);
}
