export { candidateRoots, dataBases, type RootOptions } from "./roots";
export { nameVariants, compactName, compactSlug, namesRelated, type NameVariants } from "./names";
export { candidateFileKind, isNoiseDirectory, type CandidateKind } from "./patterns";
export { probeFile, type ProbeResult, type UsageShape } from "./probe";
export {
  defaultCacheDirectory,
  discoverProviderUsage,
  type DiscoveredFile,
  type DiscoveryOptions,
  type DiscoveryResult
} from "./route";
export { CATALOG, catalogLead, type CatalogEntry } from "./catalog";
export { scanInstalledTools, type InstalledTool } from "./installed";
