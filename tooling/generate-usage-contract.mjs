import { readFileSync, writeFileSync, mkdirSync, copyFileSync } from "node:fs";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
const require = createRequire(new URL("../packages/contracts/package.json", import.meta.url));
const Ajv = require("ajv/dist/2020.js");
const addFormats = require("ajv-formats");
const standalone = require("ajv/dist/standalone/index.js");
const root = new URL("../packages/contracts/", import.meta.url);
const ajv = new Ajv({ strict: true, code: { source: true, esm: false }, allErrors: true });
addFormats(ajv);
const validate = ajv.compile(JSON.parse(readFileSync(new URL("usage-record-v1.schema.json", root), "utf8")));
writeFileSync(new URL("src/usage-validator.cjs", root), standalone(ajv, validate));
writeFileSync(new URL("src/usage-validator.d.cts", root), 'import type { UsageRecord } from "./usage";\nexport default function validate(value: unknown): value is UsageRecord;\n');
const statistics = ajv.compile(JSON.parse(readFileSync(new URL("statistics-v1.schema.json", root), "utf8")));
writeFileSync(new URL("src/statistics-validator.cjs", root), standalone(ajv, statistics));
writeFileSync(new URL("src/statistics-validator.d.cts", root), 'import type { UsageFact } from "./statistics";\nexport default function validate(value: unknown): value is UsageFact;\n');
// Check in the generated copy so the cloud repository also builds on its own.
const cloud = new URL("../../cloud/apps/cloudflare/src/usage/contracts/", import.meta.url);
mkdirSync(cloud, { recursive: true });
for (const name of ["usage.ts", "usage-validator.cjs", "usage-validator.d.cts", "statistics.ts", "statistics-validator.cjs", "statistics-validator.d.cts"]) {
  copyFileSync(new URL(`src/${name}`, root), new URL(name, cloud));
}
console.log(`Updated usage validation and cloud contracts at ${fileURLToPath(cloud)}`);

