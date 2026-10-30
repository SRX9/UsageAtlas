#!/usr/bin/env node
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import pngToIco from "png-to-ico";
import pngjs from "pngjs";

const { PNG } = pngjs;

// The three marks Settings → Appearance offers for the title bar and the window
// icon. They are built from the same two masters the installer uses, so picking
// one never produces artwork the icon pipeline does not know about.
const MARK_SIZE = 256;
// Windows draws the window and taskbar icon from the ICO, so each mark ships one
// with the sizes the shell asks for instead of a single 256 px bitmap.
const MARK_ICO_SIZES = [16, 24, 32, 48, 64, 128, 256];
const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const iconRoot = path.join(repoRoot, "apps", "desktop", "resources", "icons");
const markRoot = path.join(iconRoot, "marks");

const sources = {
  datamosh: path.join(iconRoot, "usageatlas.png"),
  classic: path.join(repoRoot, "branding", "usageatlas-primary.png")
};

await mkdir(markRoot, { recursive: true });

for (const [mark, source] of Object.entries(sources)) {
  const image = PNG.sync.read(await readFile(source));
  const small = resample(image, MARK_SIZE);
  await writeFile(path.join(markRoot, `mark-${mark}.png`), PNG.sync.write(small));
  await writeFile(
    path.join(markRoot, `mark-${mark}.ico`),
    await pngToIco(MARK_ICO_SIZES.map((size) => PNG.sync.write(size === MARK_SIZE ? small : resample(small, size))))
  );
}

// A cool duotone of the classic mark, for a taskbar that is neither light nor dark.
const classic = resample(PNG.sync.read(await readFile(sources.classic)), MARK_SIZE);
for (let pixel = 0; pixel < MARK_SIZE * MARK_SIZE; pixel += 1) {
  const offset = pixel * 4;
  const luminance = (0.2126 * classic.data[offset] + 0.7152 * classic.data[offset + 1] + 0.0722 * classic.data[offset + 2]) / 255;
  classic.data[offset] = Math.round(46 + luminance * 116);
  classic.data[offset + 1] = Math.round(78 + luminance * 138);
  classic.data[offset + 2] = Math.round(190 + luminance * 46);
}
await writeFile(path.join(markRoot, "mark-duotone.png"), PNG.sync.write(classic));
await writeFile(
  path.join(markRoot, "mark-duotone.ico"),
  await pngToIco(MARK_ICO_SIZES.map((size) => PNG.sync.write(size === MARK_SIZE ? classic : resample(classic, size))))
);

console.log(`Generated app marks in ${path.relative(repoRoot, markRoot)}`);

/** Averages every source pixel inside a destination pixel, keeping the alpha channel. */
function resample(source, size) {
  const image = new PNG({ width: size, height: size });
  const scale = source.width / size;
  for (let y = 0; y < size; y += 1) {
    const startY = Math.floor(y * scale);
    const endY = Math.min(source.height, Math.max(startY + 1, Math.ceil((y + 1) * scale)));
    for (let x = 0; x < size; x += 1) {
      const startX = Math.floor(x * scale);
      const endX = Math.min(source.width, Math.max(startX + 1, Math.ceil((x + 1) * scale)));
      const total = [0, 0, 0, 0];
      let samples = 0;
      for (let sourceY = startY; sourceY < endY; sourceY += 1) {
        for (let sourceX = startX; sourceX < endX; sourceX += 1) {
          const offset = (sourceY * source.width + sourceX) * 4;
          const alpha = source.data[offset + 3] / 255;
          total[0] += source.data[offset] * alpha;
          total[1] += source.data[offset + 1] * alpha;
          total[2] += source.data[offset + 2] * alpha;
          total[3] += alpha;
          samples += 1;
        }
      }
      const target = (y * size + x) * 4;
      const coverage = total[3] / samples;
      if (coverage > 0) {
        image.data[target] = clampByte(total[0] / total[3]);
        image.data[target + 1] = clampByte(total[1] / total[3]);
        image.data[target + 2] = clampByte(total[2] / total[3]);
      }
      image.data[target + 3] = clampByte(coverage * 255);
    }
  }
  return image;
}

function clampByte(value) {
  return Math.max(0, Math.min(255, Math.round(value)));
}
