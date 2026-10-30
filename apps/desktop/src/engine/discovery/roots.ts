import { homedir } from "node:os";
import path from "node:path";
import { nameVariants } from "./names";

export interface RootOptions {
  environment?: NodeJS.ProcessEnv;
  homeDirectory?: string;
}

/**
 * Every place a desktop app or CLI is allowed to keep per-user data, in the
 * order worth trying. Missing folders cost one failed readdir each.
 */
export function dataBases(options: RootOptions = {}): string[] {
  const environment = options.environment ?? process.env;
  const home = options.homeDirectory ?? homedir();
  const bases = [
    environment.XDG_CONFIG_HOME,
    environment.XDG_DATA_HOME,
    environment.XDG_STATE_HOME,
    path.join(home, ".config"),
    path.join(home, ".local", "share"),
    path.join(home, ".local", "state"),
    environment.APPDATA,
    environment.LOCALAPPDATA,
    path.join(home, "AppData", "Roaming"),
    path.join(home, "AppData", "Local"),
    path.join(home, "Library", "Application Support"),
    home
  ];
  return [...new Set(
    bases.filter((base): base is string => typeof base === "string" && base.length > 0).map(base => path.normalize(base))
  )];
}

/** Every folder spelling of the provider clicked onto every data base. */
export function candidateRoots(name: string, options: RootOptions = {}): string[] {
  const { variants } = nameVariants(name);
  const roots = new Set<string>();
  for (const base of dataBases(options)) {
    for (const variant of variants) roots.add(path.join(base, variant));
  }
  return [...roots];
}
