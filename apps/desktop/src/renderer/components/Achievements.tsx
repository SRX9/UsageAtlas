import type { CSSProperties } from "react";
import { achievementFamily, nextTierShare, nextTierText, type AchievementProgress } from "../achievements";
import { AchievementBadge } from "./AchievementBadge";

const EARNED_DATE = new Intl.DateTimeFormat("en-US", { month: "short", day: "numeric", year: "numeric" });

/** Every family on the Profile page: the tier reached and how far the next one is. */
export function ProfileAchievements({ live, progress }: {
  /** The profile is public, so it shows the ones earned. */
  live: boolean;
  progress: readonly AchievementProgress[];
}): React.JSX.Element {
  const earned = progress.filter((item) => item.level > 0).length;
  return (
    <section aria-labelledby="profile-achievements" className="atlas-section">
      <div className="atlas-section-heading">
        <div>
          <p className="atlas-kicker">Achievements</p>
          <h2 id="profile-achievements">{earned ? `${earned} of ${progress.length} earned` : "Your first achievements"}</h2>
        </div>
        <p>
          {live
            ? "Your public profile shows the ones you've earned, from every computer that saves to it."
            : "From the history on this computer. A public profile shows the ones you've earned."}
        </p>
      </div>
      <ul className="atlas-achievements">
        {progress.map((item) => {
          const family = achievementFamily(item.id);
          const tier = family.tiers[item.level - 1];
          const next = nextTierText(item);
          return (
            <li className="atlas-achievement" data-earned={item.level > 0 || undefined} key={item.id}>
              <div className="atlas-achievement__top">
                <AchievementBadge className="atlas-achievement__badge" id={item.id} level={item.level} />
                <span aria-hidden="true" className="atlas-achievement__pips">
                  {family.tiers.map((_, index) => <span data-on={index < item.level || undefined} key={index} />)}
                </span>
              </div>
              <h3>{tier === undefined ? family.name : family.label(tier)}</h3>
              <p>{tier === undefined ? "Not earned yet" : `Earned ${EARNED_DATE.format(new Date(`${item.earnedOn}T12:00:00`))}`}</p>
              <span className="sr-only">{tier === undefined ? "" : `${family.describe(tier)} Level ${item.level} of ${family.tiers.length}.`}</span>
              {next ? (
                <div className="atlas-achievement__next">
                  <span className="atlas-achievement__bar" style={{ "--share": nextTierShare(item) } as CSSProperties} />
                  <span>{next}</span>
                </div>
              ) : (
                <div className="atlas-achievement__next"><span>Top tier</span></div>
              )}
            </li>
          );
        })}
      </ul>
    </section>
  );
}
