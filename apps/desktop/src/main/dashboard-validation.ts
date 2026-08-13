import type { DashboardSnapshot, JsonValue } from "@usageatlas/contracts";
import dashboardSchema from "@usageatlas/contracts/dashboard-v2.schema.json";
import type { ValidateFunction } from "ajv";
import Ajv2020 from "ajv/dist/2020.js";
import addFormats from "ajv-formats";

const ajv = new Ajv2020({ allErrors: true, strict: true });
addFormats(ajv);
const validateDashboardMessage = ajv.compile(dashboardSchema) as ValidateFunction;

export function validateDashboard(value: JsonValue): DashboardSnapshot {
  if (!validateDashboardMessage(value)) {
    const first = validateDashboardMessage.errors?.[0];
    const detail = first
      ? ` at ${first.instancePath || "/"}: ${first.message}`
      : "";
    throw new Error(`Invalid dashboard snapshot${detail}`);
  }
  return value as unknown as DashboardSnapshot;
}
