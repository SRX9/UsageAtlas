import type { DashboardSnapshot } from "@usageatlas/contracts";
import { toast } from "@heroui/react";
import { useEffect, useMemo } from "react";
import type { CloudProfileStatus } from "../shared/desktop-api";
import {
  ACHIEVEMENTS_SEEN_KEY,
  achievementNudgeCopy,
  buildAchievements,
  nextAchievementNudge,
  parseSeenAchievements,
  seenAchievements,
  type AchievementProgress
} from "./achievements";
import { AchievementBadge } from "./components/AchievementBadge";
import { growthToastShowing, markGrowthToast, trackGrowth, whenInFront } from "./profile-state";

/** Later than the profile prompt's delay, so a due prompt always goes first. */
const NUDGE_DELAY_MS = 6_000;
const NUDGE_TIMEOUT_MS = 12_000;

const readSeen = () => parseSeenAchievements(localStorage.getItem(ACHIEVEMENTS_SEEN_KEY));

function rememberSeen(progress: readonly AchievementProgress[]): void {
  localStorage.setItem(ACHIEVEMENTS_SEEN_KEY, JSON.stringify(seenAchievements(progress, readSeen())));
}

/**
 * Announces a new achievement tier in a toast on usage pages, once the window has been in
 * front for a few seconds. An open profile prompt, or a Wrapped toast that just went up,
 * counts as the announcement, so they never stack. Waits while a Wrapped toast is due
 * (`waiting`), and while the profile state is unknown, since the wording depends on it.
 */
export function useAchievementNudge({ automatic, enabled, onOpen, profile, prompting, snapshot, today, waiting }: {
  automatic: boolean;
  enabled: boolean;
  onOpen(): void;
  profile: CloudProfileStatus | null;
  prompting: boolean;
  snapshot: DashboardSnapshot | null;
  today: string;
  waiting: boolean;
}): void {
  const progress = useMemo(() => snapshot ? buildAchievements(snapshot, today) : null, [snapshot, today]);

  useEffect(() => {
    if (!progress) return;
    if (prompting) {
      rememberSeen(progress);
      return;
    }
    if (!enabled || waiting || !profile || profile.state === "unknown" || !nextAchievementNudge(readSeen(), progress)) return;
    return whenInFront(NUDGE_DELAY_MS, () => {
      const nudge = nextAchievementNudge(readSeen(), progress);
      if (!nudge) return;
      rememberSeen(progress);
      if (growthToastShowing(NUDGE_TIMEOUT_MS)) return;
      markGrowthToast();
      const { title, description } = achievementNudgeCopy(nudge, { automatic, profile });
      const properties = { kind: nudge.kind, achievement: nudge.id };
      const key = toast(title, {
        description,
        indicator: <AchievementBadge height={24} id={nudge.id} level={nudge.level} width={24} />,
        actionProps: {
          children: "See achievements",
          onPress: () => {
            trackGrowth("achievement_nudge_clicked", properties);
            toast.close(key);
            onOpen();
          },
          size: "sm",
          variant: "secondary"
        },
        timeout: NUDGE_TIMEOUT_MS
      });
      trackGrowth("achievement_nudge_shown", properties);
    });
  }, [automatic, enabled, onOpen, profile, progress, prompting, waiting]);
}
