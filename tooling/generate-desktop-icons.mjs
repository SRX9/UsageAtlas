#!/usr/bin/env node
import { copyFile, mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import pngToIco from "png-to-ico";
import pngjs from "pngjs";

const { PNG } = pngjs;

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
const masterPath = path.join(
  repoRoot,
  "branding",
  "usageatlas-primary.png"
);
const destinationRoot = path.join(repoRoot, "apps", "desktop", "resources", "icons");
const pngPath = path.join(destinationRoot, "usageatlas.png");
const icoPath = path.join(destinationRoot, "usageatlas.ico");
const installerRoot = path.join(repoRoot, "apps", "desktop", "resources", "installer");
// The packaged app ships everything under resources/icons, so the icns, which
// only the macOS build reads, sits with the other build-time artwork.
const icnsPath = path.join(installerRoot, "usageatlas.icns");
const dmgBackgroundPath = path.join(installerRoot, "dmg-background.png");
const webPublicRoot = path.join(repoRoot, "apps", "web", "public");
const webLogoPath = path.join(webPublicRoot, "logo.png");
const webIconPath = path.join(webPublicRoot, "icon.ico");

await mkdir(destinationRoot, { recursive: true });
await mkdir(installerRoot, { recursive: true });
await mkdir(webPublicRoot, { recursive: true });
await copyFile(masterPath, pngPath);
const master = PNG.sync.read(await readFile(masterPath));
await writeFile(webLogoPath, PNG.sync.write(resizePng(master, 512)));
const ico = await pngToIco(pngPath);
await writeFile(icoPath, ico);
await writeFile(webIconPath, ico);
await writeFile(icnsPath, await pngToIcns(masterPath));
await writeFile(dmgBackgroundPath, PNG.sync.write(createDmgBackground()));
console.log(
  `Generated ${path.relative(repoRoot, pngPath)}, ${path.relative(repoRoot, icoPath)}, and ` +
  `${path.relative(repoRoot, icnsPath)}, ${path.relative(repoRoot, webLogoPath)}, and ` +
  `${path.relative(repoRoot, webIconPath)} from ${path.relative(repoRoot, masterPath)}, ` +
  `plus ${path.relative(repoRoot, dmgBackgroundPath)}`
);



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

async function pngToIcns(sourcePath) {
  const source = PNG.sync.read(await readFile(sourcePath));
  if (source.width !== source.height) throw new Error("UsageAtlas application icon must be square");

  const chunks = icnsRepresentations.map(([type, size]) => {
    const png = PNG.sync.write(resizePng(source, size));
    return createIcnsChunk(type, png);
  });
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

function resizePng(source, size) {
  const target = new PNG({ width: size, height: size });
  const xScale = source.width / size;
  const yScale = source.height / size;

  for (let y = 0; y < size; y += 1) {
    const sourceY = Math.max(0, (y + 0.5) * yScale - 0.5);
    const y0 = Math.floor(sourceY);
    const y1 = Math.min(source.height - 1, y0 + 1);
    const yWeight = sourceY - y0;
    for (let x = 0; x < size; x += 1) {
      const sourceX = Math.max(0, (x + 0.5) * xScale - 0.5);
      const x0 = Math.floor(sourceX);
      const x1 = Math.min(source.width - 1, x0 + 1);
      const xWeight = sourceX - x0;
      const targetOffset = (y * size + x) * 4;
      const topLeft = (y0 * source.width + x0) * 4;
      const topRight = (y0 * source.width + x1) * 4;
      const bottomLeft = (y1 * source.width + x0) * 4;
      const bottomRight = (y1 * source.width + x1) * 4;

      for (let channel = 0; channel < 4; channel += 1) {
        const top = source.data[topLeft + channel] * (1 - xWeight)
          + source.data[topRight + channel] * xWeight;
        const bottom = source.data[bottomLeft + channel] * (1 - xWeight)
          + source.data[bottomRight + channel] * xWeight;
        target.data[targetOffset + channel] = Math.round(top * (1 - yWeight) + bottom * yWeight);
      }
    }
  }
  return target;
}