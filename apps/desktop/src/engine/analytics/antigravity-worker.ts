import { parentPort, workerData } from "node:worker_threads";
import { readAntigravityDatabases, type AntigravityDatabaseInput } from "./antigravity-database";

if (!parentPort) throw new Error("Antigravity worker needs a parent port.");
parentPort.postMessage(readAntigravityDatabases(workerData as AntigravityDatabaseInput));
