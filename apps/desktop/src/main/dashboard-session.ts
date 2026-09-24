import type { DashboardSnapshot } from "@usageatlas/contracts";
import type { LocalImportProgress, DashboardState, RefreshProgress } from "../shared/desktop-api";
import type { EngineManager } from "./engine-manager";

type DashboardEngine = Pick<EngineManager,
  "getHydratedSnapshot" | "getSnapshot" | "refreshAll" | "setProviderEnabled">;

/** Owns publication as well as collection, so replies from a previous account cannot escape. */
export class DashboardSession {
  private state: DashboardState = {
    revision: 0, snapshot: null, refreshing: true, progress: null, error: null
  };
  private accountId: string | null = null;
  private generation = 0;
  private active = false;
  private configuration: Promise<unknown> | null = null;
  private configurationFailed = false;
  private needsRefresh = false;
  private running: Promise<DashboardState> | null = null;
  private hydrating: Promise<void> | null = null;
  private historyDirty = false;

  constructor(
    private readonly engine: DashboardEngine,
    private readonly changed: (state: DashboardState) => void,
    private readonly collected: (snapshot: DashboardSnapshot) => void = () => {}
  ) {}

  activate(): void { this.active = true; }

  close(): void {
    this.active = false;
    this.accountId = null;
    this.configuration = null;
    this.invalidate();
  }

  async configure(
    accountId: string,
    operation: () => Promise<unknown>,
    reconnect = false
  ): Promise<unknown> {
    const switched = this.accountId !== accountId;
    this.accountId = accountId;
    if (switched) {
      this.invalidate();
      this.publish({ snapshot: null, refreshing: true, progress: null, localImport: null, error: null });
    }
    this.needsRefresh ||= switched || reconnect || this.configurationFailed;
    const configuration = Promise.resolve().then(operation);
    this.configuration = configuration;
    try {
      const result = await configuration;
      if (this.configuration === configuration) {
        this.configuration = null;
        this.configurationFailed = false;
        const refresh = this.needsRefresh;
        this.needsRefresh = false;
        if (this.active && refresh) void this.refresh();
      }
      return result;
    } catch (error) {
      if (this.configuration === configuration) {
        this.configuration = null;
        this.configurationFailed = true;
        this.publish({ refreshing: false, progress: null, error: message(error) });
      }
      throw error;
    }
  }

  async get(): Promise<DashboardState> {
    const generation = this.generation;
    await this.configured();
    if (generation !== this.generation || this.configurationFailed) return this.state;
    if (!this.state.snapshot) await this.hydrate();
    if (generation === this.generation) void this.refresh();
    return this.state;
  }

  refresh(force = false): Promise<DashboardState> {
    if (this.configurationFailed && !this.configuration) return Promise.resolve(this.state);
    if (this.running) return this.running;
    return this.collect(() => force ? this.engine.refreshAll() : this.engine.getSnapshot());
  }

  setProviderEnabled(providerID: string, enabled: boolean): Promise<DashboardState> {
    if (this.configurationFailed && !this.configuration) return Promise.resolve(this.state);
    const configuring = this.configuration !== null;
    this.invalidate();
    return this.collect(async () => {
      const snapshot = await this.engine.setProviderEnabled(providerID, enabled);
      return configuring ? this.engine.getSnapshot() : snapshot;
    });
  }

  historyChanged(): void {
    if (!this.active || this.configuration) return;
    if (this.running || this.hydrating) this.historyDirty = true;
    else void this.hydrate();
  }

  importProgress(accountId: string, progress: LocalImportProgress | null): void {
    if (accountId === this.accountId) this.publish({ localImport: progress });
  }

  progress(progress: RefreshProgress): void {
    if (this.configuration || !this.running) return;
    this.publish({ progress });
  }

  private collect(read: () => Promise<DashboardSnapshot>): Promise<DashboardState> {
    const generation = this.generation;
    this.publish({ refreshing: true, progress: null, error: null });
    const run: Promise<DashboardState> = (async () => {
      try {
        await this.configured();
        if (generation !== this.generation || this.configurationFailed) return this.state;
        if (!this.state.snapshot) await this.hydrate();
        if (generation !== this.generation) return this.state;
        const snapshot = await read();
        if (generation === this.generation) {
          this.publish({ snapshot, refreshing: false, progress: null, error: null });
          this.collected(snapshot);
        }
      } catch (error) {
        if (generation === this.generation)
          this.publish({ refreshing: false, progress: null, error: message(error) });
      } finally {
        if (generation === this.generation) {
          this.running = null;
          if (this.historyDirty) {
            this.historyDirty = false;
            await this.hydrate();
          }
        }
      }
      return this.state;
    })();
    this.running = run;
    return run;
  }

  private hydrate(): Promise<void> {
    if (this.hydrating) return this.hydrating;
    const generation = this.generation;
    const run: Promise<void> = (async () => {
      try {
        await this.configured();
        if (generation !== this.generation || this.configurationFailed) return;
        const snapshot = await this.engine.getHydratedSnapshot();
        if (generation === this.generation) this.publish({ snapshot });
      } catch (error) {
        if (generation === this.generation && !this.running)
          this.publish({ refreshing: false, error: message(error) });
      } finally {
        if (generation === this.generation) {
          this.hydrating = null;
          if (this.historyDirty && !this.running) {
            this.historyDirty = false;
            void this.hydrate();
          }
        }
      }
    })();
    this.hydrating = run;
    return run;
  }

  private async configured(): Promise<void> {
    while (this.configuration) await this.configuration.catch(() => undefined);
  }

  private invalidate(): void {
    this.generation += 1;
    this.running = null;
    this.hydrating = null;
    this.historyDirty = false;
  }

  private publish(patch: Partial<Omit<DashboardState, "revision">>): void {
    this.state = { ...this.state, ...patch, revision: this.state.revision + 1 };
    this.changed(this.state);
  }
}

function message(error: unknown): string {
  return error instanceof Error ? error.message : "Usage could not be refreshed. Try again.";
}
