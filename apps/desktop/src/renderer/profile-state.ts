import type { DashboardSnapshot } from "@usageatlas/contracts";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { CloudProfileStatus, CloudStatus, LeaderboardGlance } from "../shared/desktop-api";
import type { GrowthEvent, GrowthEventProperties } from "../shared/growth-events";
import {
  buildProfilePreview,
  nextPrompt,
  parsePromptState,
  PROMPT_STATE_KEY,
  recordPromptDismissed,
  recordPromptShown,
  type ProfilePreviewData,
  type ProfilePromptState,
  type PromptTrigger
} from "./profile-promotion";

const IDLE_POLL_MS = 60_000;
const SIGN_IN_POLL_MS = 3_000;
/** Each check reads the cloud database, so focus alone asks the website twice an hour at most. */
const FOCUS_RECHECK_MS = 30 * 60_000;
/** After the app opens the website, a publish may be waiting, so the next focus asks soon. */
const WEBSITE_RECHECK_MS = 30_000;
/** Opening the Profile page asks too, at most once a minute. */
const PAGE_RECHECK_MS = 60_000;
/** Let the usage page settle before anything covers it. */
const PROMPT_DELAY_MS = 4_000;
const PAGE_VISITED_KEY = "usageatlas.profilePageVisited";

export type ProfileCloudAction = "sign-in" | "sign-out" | "refresh-profile";

let websiteOpenedAt = Number.NEGATIVE_INFINITY;

/** Notes a trip to the website, so the next focus checks the profile without the long wait. */
export function markWebsiteOpened(now = Date.now()): void {
  websiteOpenedAt = now;
}

/** Whether the window coming back should ask the website for the profile again. */
export function focusRecheckDue(now: number, lastCheck: number, openedAt = websiteOpenedAt): boolean {
  return now - lastCheck >= (openedAt > lastCheck ? WEBSITE_RECHECK_MS : FOCUS_RECHECK_MS);
}

export interface CloudAccountState {
  status: CloudStatus | null;
  /** `status.profile`, kept as one object while it says the same, so effects keyed on it stay put. */
  profile: CloudProfileStatus | null;
  pending: ProfileCloudAction | null;
  error: string | null;
  act(action: ProfileCloudAction): Promise<CloudStatus | null>;
}

/**
 * The account and profile state behind the profile page and prompt. It asks the website
 * again when the window regains focus or the Profile page opens, so a profile published
 * in the browser shows up when the user comes back. Main checks when it opens a window.
 */
export function useCloudAccount(profileOpen = false): CloudAccountState {
  const [status, setStatus] = useState<CloudStatus | null>(null);
  const [pending, setPending] = useState<ProfileCloudAction | null>(null);
  const [error, setError] = useState<string | null>(null);
  const lastCheck = useRef(0);
  const previousAccount = useRef<string | null | undefined>(undefined);
  const waiting = Boolean(status?.loginCode);
  const accountId = status ? status.account?.id ?? null : undefined;
  // Every poll, focus check, and save step brings a new status object.
  const profileKey = status ? JSON.stringify(status.profile) : null;
  const profile = useMemo<CloudProfileStatus | null>(() => profileKey === null ? null : JSON.parse(profileKey), [profileKey]);

  useEffect(() => {
    let active = true;
    let timer: ReturnType<typeof setTimeout>;
    const poll = async () => {
      try {
        const next = await window.usageAtlas.getCloudStatus();
        if (active) setStatus(next);
      } catch { /* Keep the last known status. */ }
      if (active) timer = setTimeout(() => void poll(), waiting ? SIGN_IN_POLL_MS : IDLE_POLL_MS);
    };
    void poll();
    return () => {
      active = false;
      clearTimeout(timer);
    };
  }, [waiting]);

  // A fresh sign-in waits for its profile check instead of the next slow poll.
  useEffect(() => {
    const previous = previousAccount.current;
    previousAccount.current = accountId;
    if (previous === null && accountId) window.usageAtlas.cloudAction("refresh-profile").then(setStatus, () => undefined);
  }, [accountId]);

  const check = useCallback(() => {
    lastCheck.current = Date.now();
    window.usageAtlas.cloudAction("refresh-profile").then(setStatus, () => undefined);
  }, []);

  useEffect(() => {
    // Main checked when it opened this window.
    lastCheck.current = Date.now();
    const recheck = () => {
      if (focusRecheckDue(Date.now(), lastCheck.current)) check();
    };
    window.addEventListener("focus", recheck);
    return () => window.removeEventListener("focus", recheck);
  }, [check]);

  // Covers a publish from a browser the app did not open.
  useEffect(() => {
    if (profileOpen && Date.now() - lastCheck.current >= PAGE_RECHECK_MS) check();
  }, [profileOpen, check]);

  const act = useCallback(async (action: ProfileCloudAction) => {
    setPending(action);
    setError(null);
    try {
      const next = await window.usageAtlas.cloudAction(action);
      setStatus(next);
      return next;
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : "Cloud request failed. Try again.");
      return null;
    } finally {
      setPending(null);
    }
  }, []);

  return { status, profile, pending, error, act };
}

export function trackGrowth<E extends GrowthEvent>(event: E, properties: GrowthEventProperties<E>): void {
  window.usageAtlas.trackGrowthEvent(event, properties).catch(() => undefined);
}

/**
 * Calls `show` once the window has been in front for `delay` ms. While it's hidden or
 * unfocused, waits for it to come back instead of giving up. Returns the cleanup.
 */
export function whenInFront(delay: number, show: () => void): () => void {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const stop = () => {
    clearTimeout(timer);
    window.removeEventListener("focus", arm);
    document.removeEventListener("visibilitychange", arm);
  };
  function arm(): void {
    clearTimeout(timer);
    timer = setTimeout(() => {
      if (document.visibilityState !== "visible" || !document.hasFocus()) return;
      stop();
      show();
    }, delay);
  }
  window.addEventListener("focus", arm);
  document.addEventListener("visibilitychange", arm);
  arm();
  return stop;
}

let lastGrowthToast = Number.NEGATIVE_INFINITY;

/** Notes a growth toast going up, so the next one can stand aside instead of stacking. */
export function markGrowthToast(): void {
  lastGrowthToast = Date.now();
}

export function growthToastShowing(timeout: number): boolean {
  return Date.now() - lastGrowthToast < timeout;
}

function readPromptState(now: Date): ProfilePromptState {
  const raw = localStorage.getItem(PROMPT_STATE_KEY);
  const state = parsePromptState(raw, now);
  // Remember the first launch with this version, so prompts wait a few days after it.
  if (raw === null) writePromptState(state);
  return state;
}

function writePromptState(state: ProfilePromptState): void {
  localStorage.setItem(PROMPT_STATE_KEY, JSON.stringify(state));
}

export interface ProfilePrompt {
  trigger: PromptTrigger;
  preview: ProfilePreviewData;
}

/**
 * Picks the moment for the profile modal: only on usage pages, a few seconds after
 * they load, while the window is in front. Showing it counts at once, so a crash or
 * reload can never show it twice.
 */
export function useProfilePrompt({ enabled, profile, snapshot, today }: {
  enabled: boolean;
  profile: CloudProfileStatus | null;
  snapshot: DashboardSnapshot | null;
  today: string;
}): { prompt: ProfilePrompt | null; preview: ProfilePreviewData | null; dismiss(choice: "later" | "never"): void; close(): void } {
  const preview = useMemo(() => snapshot ? buildProfilePreview(snapshot, today) : null, [snapshot, today]);
  const [prompt, setPrompt] = useState<ProfilePrompt | null>(null);

  useEffect(() => {
    if (!enabled || prompt || !preview || !profile) return;
    if (!nextPrompt(readPromptState(new Date()), profile, preview, new Date())) return;
    // Main keeps the board for ten minutes, so the modal opens with its rank in place.
    // Only a window in front fetches it: a hidden one would refetch on every usage refresh.
    const stopPrefetch = whenInFront(0, () => void window.usageAtlas.getLeaderboard().catch(() => undefined));
    const stopPrompt = whenInFront(PROMPT_DELAY_MS, () => {
      const now = new Date();
      const state = readPromptState(now);
      const trigger = nextPrompt(state, profile, preview, now);
      if (!trigger) return;
      writePromptState(recordPromptShown(state, preview, now));
      setPrompt({ trigger, preview });
      trackGrowth("profile_prompt_shown", { trigger: trigger.kind, surface: "modal" });
    });
    return () => {
      stopPrefetch();
      stopPrompt();
    };
  }, [enabled, preview, profile, prompt]);

  return {
    prompt,
    preview,
    dismiss: (choice) => {
      if (prompt) {
        writePromptState(recordPromptDismissed(readPromptState(new Date()), choice));
        trackGrowth("profile_prompt_dismissed", { trigger: prompt.trigger.kind, choice });
      }
      setPrompt(null);
    },
    close: () => setPrompt(null)
  };
}

/**
 * The public leaderboard while `active`, or null until it loads. Failures stay quiet:
 * the rank is a bonus, never something the page waits for.
 */
export function useLeaderboard(active: boolean): LeaderboardGlance | null {
  const [glance, setGlance] = useState<LeaderboardGlance | null>(null);
  useEffect(() => {
    if (!active) return;
    let current = true;
    window.usageAtlas.getLeaderboard().then((value) => { if (current) setGlance(value); }, () => undefined);
    return () => { current = false; };
  }, [active]);
  return glance;
}

/** A dot on the Profile rail button until the page has been opened once. */
export function useProfilePageVisited(route: string): boolean {
  const [visited, setVisited] = useState(() => localStorage.getItem(PAGE_VISITED_KEY) === "1");
  if (route === "profile" && !visited) setVisited(true);
  useEffect(() => {
    if (visited) localStorage.setItem(PAGE_VISITED_KEY, "1");
  }, [visited]);
  return visited;
}
