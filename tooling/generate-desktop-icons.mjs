#!/usr/bin/env node
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import pngToIco from "png-to-ico";
import pngjs from "pngjs";

const { PNG } = pngjs;

// The artwork is a rounded square whose corners were painted over black rather
// than cut out, so every icon carried four black wedges. The silhouette is a
// plain circular arc: fitting one to the master's own edge lands on r/side =
// 214/1254 with a 0.4 px residual, so the mask below reproduces the drawn shape
// instead of guessing at a radius.
const CORNER_RADIUS_RATIO = 214 / 1254;
// Coverage is sampled on a grid inside each pixel; 4x4 keeps the corners smooth
// at 16 px without the cost of a full-resolution mask.
const COVERAGE_SAMPLES = 4;
// Below this the matte dominates the pixel and dividing it out only amplifies
// noise, so those pixels take a bled colour instead.
const MIN_MATTE_COVERAGE = 0.25;

const appPngSize = 1024;
const webLogoSize = 512;
const icoSizes = [16, 24, 32, 48, 64, 128, 256];
// The favicon is fetched on every page view and Windows only reads the small
// representations of the installer's `iconUrl`, so the web copy stops at 48.
const webIcoSizes = [16, 32, 48];
const icnsRepresentations = [
  ["icp4", 16],
  ["icp5", 32],
  ["icp6", 64],
  ["ic07", 128],
  ["ic08", 256],
  ["ic09", 512],
  ["ic10", 1024]
];

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const brandingRoot = path.join(repoRoot, "branding");
const masterPath = path.join(brandingRoot, "usageatlas-primary.png");
const brandingLogoPath = path.join(brandingRoot, "usageatlas-logo.png");
const destinationRoot = path.join(repoRoot, "apps", "desktop", "resources", "icons");
const pngPath = path.join(destinationRoot, "usageatlas.png");
const icoPath = path.join(destinationRoot, "usageatlas.ico");
const installerRoot = path.join(repoRoot, "apps", "desktop", "resources", "installer");
// The packaged app ships everything under resources/icons, so the icns, which
// only the macOS build reads, sits with the other build-time artwork.
const icnsPath = path.join(installerRoot, "usageatlas.icns");
const supersededIcnsPath = path.join(destinationRoot, "usageatlas.icns");
const dmgBackgroundPath = path.join(installerRoot, "dmg-background.png");
const webPublicRoot = path.join(repoRoot, "apps", "web", "public");
const webLogoPath = path.join(webPublicRoot, "logo.png");
const webIconPath = path.join(webPublicRoot, "icon.ico");

await mkdir(destinationRoot, { recursive: true });
await mkdir(installerRoot, { recursive: true });
await mkdir(webPublicRoot, { recursive: true });

/** Horizontal bands: the share of the height they cover and how far they slide. */
const GLITCH_BANDS = [
  { to: 0.12, shift: 0 },
  { to: 0.2, shift: 34 },
  { to: 0.29, shift: -14 },
  { to: 0.44, shift: 0 },
  { to: 0.52, shift: -52 },
  { to: 0.66, shift: 22 },
  { to: 0.83, shift: 0 },
  { to: 0.9, shift: -30 },
  { to: 1, shift: 0 }
];
/** Channel separation in pixels: red arrives late, blue early. */
const GLITCH_CHANNEL_SHIFT = 5;
/** Torn scanlines, each carrying its own tint. */
const GLITCH_TEARS = [
  { at: 0.283, thickness: 4, tint: [90, 255, 235] },
  { at: 0.523, thickness: 5, tint: [255, 90, 220] },
  { at: 0.845, thickness: 3, tint: [255, 240, 130] }
];

const artwork = readArtwork(PNG.sync.read(await readFile(masterPath)));
// This fork's desktop icon is deliberately datamoshed, so a copy of it is never
// mistaken for the official build: channels split, a few bands slid sideways and
// three scanlines torn. It is glitched once at the app size and reduced from
// there, so every size carries the same marks in the same places. The branding
// and web copies keep the untouched artwork.
const glitchedIcon = glitchIcon(renderIcon(artwork, appPngSize));
// Writing the cut-out master back keeps the branding copy matching what ships,
// and makes a second run a no-op because `readArtwork` honours an alpha channel
// that is already there.
await writeFile(masterPath, PNG.sync.write(renderIcon(artwork, artwork.width)));
await writeFile(brandingLogoPath, PNG.sync.write(renderIcon(artwork, webLogoSize)));
await writeFile(pngPath, PNG.sync.write(glitchedIcon));
await writeFile(webLogoPath, PNG.sync.write(renderIcon(artwork, webLogoSize)));
await writeFile(icoPath, await renderAppIco(icoSizes));
await writeFile(webIconPath, await renderIco(artwork, webIcoSizes));
await writeFile(icnsPath, renderAppIcns());
await writeFile(dmgBackgroundPath, PNG.sync.write(createDmgBackground()));
await rm(supersededIcnsPath, { force: true });

const written = [
  masterPath,
  brandingLogoPath,
  pngPath,
  icoPath,
  webLogoPath,
  webIconPath,
  icnsPath,
  dmgBackgroundPath
];
console.log(`Generated ${written.map((file) => path.relative(repoRoot, file)).join(", ")}`);

// The master was flattened onto black, so a drawn corner pixel is the artwork
// already multiplied by the mask. Dividing that back out recovers the colour,
// and bleeding it outwards stops the matte creeping back in when a smaller icon
// averages across the edge.
function readArtwork(master) {
  if (master.width !== master.height) throw new Error("UsageAtlas application icon must be square");

  const { width } = master;
  const coverage = roundedSquareCoverage(width);
  const matted = isOpaque(master);
  const rgb = new Float64Array(width * width * 3);
  const known = new Uint8Array(width * width);

  for (let pixel = 0; pixel < width * width; pixel += 1) {
    const alpha = matted ? coverage[pixel] : master.data[pixel * 4 + 3] / 255;
    if (alpha < MIN_MATTE_COVERAGE) continue;
    known[pixel] = 1;
    for (let channel = 0; channel < 3; channel += 1) {
      const value = master.data[pixel * 4 + channel];
      rgb[pixel * 3 + channel] = matted ? Math.min(255, value / alpha) : value;
    }
  }

  bleedOutwards(rgb, known, width);
  return { width, rgb, coverage };
}

function isOpaque(image) {
  for (let offset = 3; offset < image.data.length; offset += 4) {
    if (image.data[offset] !== 255) return false;
  }
  return true;
}

// Repeatedly averages each unknown pixel from its known neighbours so the area
// outside the silhouette holds the colour of the artwork beside it.
function bleedOutwards(rgb, known, width) {
  let frontier = [];
  for (let pixel = 0; pixel < known.length; pixel += 1) {
    if (!known[pixel]) frontier.push(pixel);
  }

  while (frontier.length > 0) {
    const filled = [];
    const remaining = [];
    for (const pixel of frontier) {
      const x = pixel % width;
      const y = (pixel - x) / width;
      const total = [0, 0, 0];
      let count = 0;
      for (let dy = -1; dy <= 1; dy += 1) {
        for (let dx = -1; dx <= 1; dx += 1) {
          const nx = x + dx;
          const ny = y + dy;
          if (nx < 0 || ny < 0 || nx >= width || ny >= width) continue;
          const neighbour = ny * width + nx;
          if (!known[neighbour]) continue;
          count += 1;
          for (let channel = 0; channel < 3; channel += 1) {
            total[channel] += rgb[neighbour * 3 + channel];
          }
        }
      }
      if (count === 0) {
        remaining.push(pixel);
        continue;
      }
      for (let channel = 0; channel < 3; channel += 1) rgb[pixel * 3 + channel] = total[channel] / count;
      filled.push(pixel);
    }
    // Nothing reached a known pixel, so the rest is unreachable and repeating
    // the pass would spin forever.
    if (filled.length === 0) break;
    for (const pixel of filled) known[pixel] = 1;
    frontier = remaining;
  }
}

// Every size gets its mask sampled at that size rather than resampled down from
// a larger one, so a 16 px corner is as clean as a 1024 px corner.
function renderIcon(artwork, size) {
  const rgb = resampleRgb(artwork, size);
  const coverage = size === artwork.width ? artwork.coverage : roundedSquareCoverage(size);
  const image = new PNG({ width: size, height: size });

  for (let pixel = 0; pixel < size * size; pixel += 1) {
    for (let channel = 0; channel < 3; channel += 1) {
      image.data[pixel * 4 + channel] = clampByte(rgb[pixel * 3 + channel]);
    }
    image.data[pixel * 4 + 3] = clampByte(coverage[pixel] * 255);
  }
  return image;
}

// Averages every source pixel that falls inside a destination pixel. Bilinear
// sampling reads only a 2x2 neighbourhood, which throws away most of a 1254 px
// master on the way down to 16 px and leaves the small icons speckled.
function resampleRgb(artwork, size) {
  const { width, rgb } = artwork;
  if (size === width) return rgb;
  if (size > width) throw new Error(`Cannot render a ${size}px icon from a ${width}px master`);

  const scale = width / size;
  const target = new Float64Array(size * size * 3);
  for (let y = 0; y < size; y += 1) {
    const startY = Math.floor(y * scale);
    const endY = Math.max(startY + 1, Math.min(width, Math.ceil((y + 1) * scale)));
    for (let x = 0; x < size; x += 1) {
      const startX = Math.floor(x * scale);
      const endX = Math.max(startX + 1, Math.min(width, Math.ceil((x + 1) * scale)));
      const total = [0, 0, 0];
      for (let sourceY = startY; sourceY < endY; sourceY += 1) {
        for (let sourceX = startX; sourceX < endX; sourceX += 1) {
          const source = (sourceY * width + sourceX) * 3;
          for (let channel = 0; channel < 3; channel += 1) total[channel] += rgb[source + channel];
        }
      }
      const count = (endY - startY) * (endX - startX);
      const destination = (y * size + x) * 3;
      for (let channel = 0; channel < 3; channel += 1) {
        target[destination + channel] = total[channel] / count;
      }
    }
  }
  return target;
}

function roundedSquareCoverage(size) {
  const radius = size * CORNER_RADIUS_RATIO;
  const coverage = new Float64Array(size * size);
  const step = 1 / COVERAGE_SAMPLES;
  const samples = COVERAGE_SAMPLES * COVERAGE_SAMPLES;

  for (let y = 0; y < size; y += 1) {
    for (let x = 0; x < size; x += 1) {
      // Away from the corners the shape is a full-bleed square, so the arc test
      // only runs on the pixels that can straddle the boundary. The bounds use
      // the whole pixel, not its origin, so no partly covered pixel is skipped.
      const spansCornerX = x < radius || x + 1 > size - radius;
      const spansCornerY = y < radius || y + 1 > size - radius;
      if (!spansCornerX || !spansCornerY) {
        coverage[y * size + x] = 1;
        continue;
      }
      let inside = 0;
      for (let sampleY = 0; sampleY < COVERAGE_SAMPLES; sampleY += 1) {
        const pointY = y + (sampleY + 0.5) * step;
        for (let sampleX = 0; sampleX < COVERAGE_SAMPLES; sampleX += 1) {
          const pointX = x + (sampleX + 0.5) * step;
          if (isInsideRoundedSquare(pointX, pointY, size, radius)) inside += 1;
        }
      }
      coverage[y * size + x] = inside / samples;
    }
  }
  return coverage;
}

// How far the point sits outside the rectangle joining the four arc centres.
// Both offsets are zero along the straight edges, which leaves the arc test to
// the corners without having to decide up front which corner a sample is in.
function isInsideRoundedSquare(x, y, size, radius) {
  const dx = Math.max(radius - x, x - (size - radius), 0);
  const dy = Math.max(radius - y, y - (size - radius), 0);
  return dx * dx + dy * dy <= radius * radius;
}

function clampByte(value) {
  return Math.max(0, Math.min(255, Math.round(value)));
}

function renderIco(artwork, sizes) {
  return pngToIco(sizes.map((size) => PNG.sync.write(renderIcon(artwork, size))));
}

/** One size of this fork's datamoshed desktop icon. */
function renderAppIcon(size) {
  if (size === appPngSize) return glitchedIcon;
  return { width: size, height: size, data: reduceIcon(glitchedIcon, size) };
}

function renderAppIco(sizes) {
  return pngToIco(sizes.map((size) => PNG.sync.write(renderAppIcon(size))));
}

/** Splits the channels, slides bands of rows and tears three scanlines. */
function glitchIcon(image) {
  const { width, height } = image;
  const source = image.data;
  const pixels = Buffer.alloc(source.length);
  const at = (x, y) => (y * width + x) * 4;
  const shiftFor = (y) => GLITCH_BANDS.find((band) => y / height < band.to)?.shift ?? 0;

  for (let y = 0; y < height; y += 1) {
    const shift = shiftFor(y);
    for (let x = 0; x < width; x += 1) {
      const target = at(x, y);
      // The band slides sideways and wraps, so the pixels leaving one edge come
      // back on the other: a block that reads as corrupted data, not a gap.
      const slid = shift === 0 ? x : (x - shift + width) % width;
      pixels[target] = source[at(Math.min(width - 1, slid + GLITCH_CHANNEL_SHIFT), y)];
      pixels[target + 1] = source[at(slid, y) + 1];
      pixels[target + 2] = source[at(Math.max(0, slid - GLITCH_CHANNEL_SHIFT), y) + 2];
      pixels[target + 3] = source[at(slid, y) + 3];
    }
  }

  for (const tear of GLITCH_TEARS) {
    const top = Math.round(tear.at * height);
    const span = Math.round(0.4 * width);
    const left = Math.round(tear.at * (width - span));
    for (let y = top; y < Math.min(height, top + tear.thickness); y += 1) {
      for (let x = left; x < left + span; x += 1) {
        const target = at(x, y);
        // A line of pixels from the opposite edge, laid down where it does not belong.
        const sample = at(width - 1 - x, top);
        pixels[target] = mixTint(pixels[sample], tear.tint[0]);
        pixels[target + 1] = mixTint(pixels[sample + 1], tear.tint[1]);
        pixels[target + 2] = mixTint(pixels[sample + 2], tear.tint[2]);
        pixels[target + 3] = pixels[sample + 3];
      }
    }
  }
  return { width, height, data: pixels };
}

function mixTint(channel, tint) {
  return Math.round(channel * 0.45 + tint * 0.55);
}

/** Box filter: the small entries stay a faithful reduction of the marks. */
function reduceIcon(image, size) {
  const { width, height, data } = image;
  const pixels = Buffer.alloc(size * size * 4);
  const scale = width / size;
  for (let y = 0; y < size; y += 1) {
    for (let x = 0; x < size; x += 1) {
      const sums = [0, 0, 0, 0];
      let count = 0;
      for (let sourceY = Math.floor(y * scale); sourceY < Math.min(height, Math.ceil((y + 1) * scale)); sourceY += 1) {
        for (let sourceX = Math.floor(x * scale); sourceX < Math.min(width, Math.ceil((x + 1) * scale)); sourceX += 1) {
          const at = (sourceY * width + sourceX) * 4;
          for (let channel = 0; channel < 4; channel += 1) sums[channel] += data[at + channel];
          count += 1;
        }
      }
      const target = (y * size + x) * 4;
      for (let channel = 0; channel < 4; channel += 1) pixels[target + channel] = Math.round(sums[channel] / count);
    }
  }
  return pixels;
}

function renderAppIcns() {
  const chunks = icnsRepresentations.map(([type, size]) => (
    createIcnsChunk(type, PNG.sync.write(renderAppIcon(size)))
  ));
  const totalLength = 8 + chunks.reduce((length, chunk) => length + chunk.length, 0);
  const header = Buffer.alloc(8);
  header.write("icns", 0, "ascii");
  header.writeUInt32BE(totalLength, 4);
  return Buffer.concat([header, ...chunks], totalLength);
}

function renderIcns(artwork) {
  const chunks = icnsRepresentations.map(([type, size]) => (
    createIcnsChunk(type, PNG.sync.write(renderIcon(artwork, size)))
  ));
  const totalLength = 8 + chunks.reduce((length, chunk) => length + chunk.length, 0);
  const header = Buffer.alloc(8);
  header.write("icns", 0, "ascii");
  header.writeUInt32BE(totalLength, 4);
  return Buffer.concat([header, ...chunks], totalLength);
}

function createIcnsChunk(type, data) {
  const chunk = Buffer.alloc(8 + data.length);
  chunk.write(type, 0, "ascii");
  chunk.writeUInt32BE(chunk.length, 4);
  data.copy(chunk, 8);
  return chunk;
}

// 658x498 is the stock dmg window; the icons sit at (192, 344) and (448, 344).
function createDmgBackground() {
  const width = 658;
  const height = 498;
  const top = [255, 255, 255];
  const bottom = [242, 242, 244];
  const arrow = [110, 110, 115];
  const arrowOpacity = 0.42;
  const image = new PNG({ width, height });

  for (let y = 0; y < height; y += 1) {
    const shade = y / (height - 1);
    for (let x = 0; x < width; x += 1) {
      const offset = (y * width + x) * 4;
      const ink = arrowCoverage(x, y) * arrowOpacity;
      for (let channel = 0; channel < 3; channel += 1) {
        const base = top[channel] + (bottom[channel] - top[channel]) * shade;
        image.data[offset + channel] = Math.round(base * (1 - ink) + arrow[channel] * ink);
      }
      image.data[offset + 3] = 255;
    }
  }
  return image;
}

// Supersampled so the arrow keeps clean edges without an image library.
function arrowCoverage(x, y) {
  const samples = 4;
  let covered = 0;
  for (let sampleY = 0; sampleY < samples; sampleY += 1) {
    for (let sampleX = 0; sampleX < samples; sampleX += 1) {
      const pointX = x + (sampleX + 0.5) / samples;
      const pointY = y + (sampleY + 0.5) / samples;
      if (isInsideArrow(pointX, pointY)) covered += 1;
    }
  }
  return covered / (samples * samples);
}

function isInsideArrow(x, y) {
  const centerY = 344;
  const shaftStart = 286;
  const shaftEnd = 330;
  const shaftRadius = 5;
  const headBase = 326;
  const headTip = 358;
  const headHalfHeight = 17;

  const nearestX = Math.min(Math.max(x, shaftStart), shaftEnd);
  const shaftDistance = (x - nearestX) ** 2 + (y - centerY) ** 2;
  if (shaftDistance <= shaftRadius ** 2) return true;

  if (x < headBase || x > headTip) return false;
  const alongHead = (x - headBase) / (headTip - headBase);
  return Math.abs(y - centerY) <= headHalfHeight * (1 - alongHead);
}
