import fixtureSnapshot from "@usageatlas/contracts/fixtures/dashboard-v2.json";
import type { DashboardSnapshot } from "@usageatlas/contracts";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { CloudProfileStatus, CloudStatus, LeaderboardGlance } from "../../shared/desktop-api";
import type { CloudAccountState } from "../profile-state";
import { AppShell } from "./AppShell";
import { ProfilePage } from "./ProfilePage";
import { RecapShare } from "./RecapShare";

const snapshot = fixtureSnapshot as unknown as DashboardSnapshot;

describe("Profile page", () => {
  // The fixture's day, outside the December and January Wrapped season.
  beforeEach(() => { vi.useFakeTimers({ now: new Date("2026-07-17T12:00:00Z"), toFake: ["Date"] }); });
  afterEach(() => { vi.useRealTimers(); });

  it("waits for the account check before choosing what to offer", () => {
    const html = render(null);

    expect(html).toContain("Checking your profile...");
    expect(html).not.toContain("Choose your handle");
  });

  it("lets a signed-out user pick a handle before signing in", () => {
    const html = render(status(null, { state: "signed-out" }));

    expect(html).toContain("Show what you build with AI");
    expect(html).toContain("Choose your handle");
    expect(html).toContain("Sign in to claim");
    expect(html).toContain("Signing in creates a free account");
    expect(html).toContain("Never prompts, code, or project names.");
    expect(html).toContain("Why publish");
  });

  it("offers the claim form to a signed-in account without a profile", () => {
    const html = render(status(account, { state: "missing" }));

    expect(html).toContain("Claim on usageatlas.com");
    expect(html).toContain("Signed in as ada@example.com.");
    expect(html).not.toContain("Cloud save is off");
  });

  it("warns that a profile stays empty while cloud save is off", () => {
    const html = render({ ...status(account, { state: "missing" }), automatic: false });

    expect(html).toContain("Cloud save is off, so your profile would stay empty.");
    expect(html).toContain("Turn it on in Settings");
  });

  it("sends a private profile to the website to publish", () => {
    const html = render(status(account, { state: "private", handle: "ada_l" }));

    expect(html).toContain("Your profile is ready to publish");
    expect(html).toContain("@ada_l is saved, but only you can see it.");
    expect(html).toContain("Publish on usageatlas.com");
    expect(html).not.toContain("Choose your handle");
  });

  it("links a live profile and stops selling it", () => {
    const html = render(status(account, { state: "public", handle: "ada_l" }));

    expect(html).toContain("Your profile is live");
    expect(html).toContain("usageatlas.com/@ada_l");
    expect(html).toContain("View profile");
    expect(html).not.toContain("Why publish");
  });

  it("never reads a failed check as a missing profile", () => {
    const html = render(status(account, { state: "unknown" }));

    expect(html).toContain("We couldn&#x27;t check your profile");
    expect(html).toContain("Try again");
    expect(html).not.toContain("Choose your handle");
  });

  it("places a new profile on the leaderboard beside the faces already there", () => {
    const html = render(status(null, { state: "signed-out" }), glance);

    expect(html).toContain("You&#x27;d be #2 of 4 on the leaderboard");
    expect(html).toContain("By tokens in the last 30 days. Join 12 people with public profiles.");
    expect(html).toContain('src="data:image/png;base64,AAAA"');
    expect(html).toContain(">GH</span>");
    expect(html).toContain("See the leaderboard");
    expect(html).toContain("A place on the leaderboard");
  });

  it("shows a live profile its own rank", () => {
    const html = render(status(account, { state: "public", handle: "ada_l" }), glance);

    expect(html).toContain("You&#x27;re #1 of 3 on the leaderboard");
    expect(html).not.toContain("Join 12 people");
    expect(html).toContain("See the leaderboard");
  });

  it("hands a live profile README cards to copy", () => {
    const html = render(status(account, { state: "public", handle: "ada_l" }));

    expect(html).toContain("Put your usage in your README");
    expect(html).toContain("[![AI Coding Activity on UsageAtlas](https://usageatlas.com/api/cards/ada_l/heatmap.svg?theme=light)](https://usageatlas.com/@ada_l)");
    expect(html).toContain('src="https://usageatlas.com/api/cards/ada_l/heatmap.svg?theme=light"');
    expect(html).toContain("Copy Markdown");
    expect(html).toContain("More styles on usageatlas.com");
    expect(html).not.toContain("Cloud save is off");
  });

  it("warns that cards stop updating while cloud save is off", () => {
    const html = render({ ...status(account, { state: "public", handle: "ada_l" }), automatic: false });

    expect(html).toContain("Cloud save is off, so cards only show usage saved earlier.");
  });

  it("keeps README cards for published profiles", () => {
    expect(render(status(account, { state: "private", handle: "ada_l" }))).not.toContain("Put your usage in your README");
    expect(render(status(null, { state: "signed-out" }))).not.toContain("Put your usage in your README");
  });

  it("offers a recap image that links to the live profile", () => {
    const html = render(status(account, { state: "public", handle: "ada_l" }));

    expect(html).toContain("Share your week or month");
    expect(html).toContain("My week in AI coding");
    expect(html).toContain("<strong>1,800</strong> tokens");
    expect(html).toContain('<span class="atlas-recap__link">usageatlas.com/@ada_l</span>');
    expect(html).toContain("Copy image");
    expect(html).toContain("Save image");
    expect(html).toContain("Post on X");
    expect(html).toContain("Post on Bluesky");
    expect(html).toContain("The image and post link to usageatlas.com/@ada_l.");
  });

  it("puts the website on a recap until the profile is public", () => {
    for (const html of [render(status(null, { state: "signed-out" })), render(status(account, { state: "private", handle: "ada_l" }))]) {
      expect(html).toContain("My week in AI coding");
      expect(html).toContain('<span class="atlas-recap__link">usageatlas.com</span>');
      expect(html).toContain("With a public profile, the image and post link to your own page.");
    }
    expect(render(null)).not.toContain("Share your week or month");
  });

  it("has nothing to share after a quiet week", () => {
    const html = renderToStaticMarkup(
      <RecapShare onGetProfile={vi.fn()} onOpenExternal={vi.fn()} profileHandle={null} snapshot={snapshot} today="2026-07-30" />
    );

    expect(html).toContain("No usage in the last 7 days yet.");
    expect(html).not.toContain("atlas-recap__total");
    expect(html).toContain("Get your profile");
    expect(html.match(/data-disabled="true"/gu)?.length).toBe(4);
  });

  it("shows how far each achievement is from this computer's history", () => {
    const html = render(status(null, { state: "signed-out" }));

    expect(html).toContain("Your first achievements");
    expect(html).toContain("From the history on this computer. A public profile shows the ones you&#x27;ve earned.");
    expect(html.match(/Not earned yet/gu)?.length).toBe(5);
    expect(html).toContain("1,800 of 1,000,000 tokens");
    expect(html).toContain("2 of 7 days");
    expect(html).toContain("1 of 2 tools");
    expect(render(null)).not.toContain("profile-achievements");
  });

  it("tells a live profile its earned achievements are on it", () => {
    const html = render(status(account, { state: "public", handle: "ada_l" }));

    expect(html).toContain("Your public profile shows the ones you&#x27;ve earned, from every computer that saves to it.");
  });

  it("leaves the rank out until the leaderboard loads", () => {
    const html = render(status(account, { state: "private", handle: "ada_l" }));

    expect(html).not.toContain("atlas-leaderboard-standing");
    expect(html).toContain("Publish on usageatlas.com");
  });

  it("opens a live profile's Wrapped in December and January", () => {
    const live = status(account, { state: "public", handle: "ada_l" });
    expect(render(live)).not.toContain("Wrapped");

    vi.setSystemTime(new Date("2026-12-11T12:00:00Z"));
    const html = render(live);
    expect(html).toContain("AI Coding Wrapped · 2026");
    expect(html).toContain("Your 2026 Wrapped is ready");
    expect(html).toContain("Open your Wrapped");

    vi.setSystemTime(new Date("2027-01-31T12:00:00Z"));
    expect(render(live)).toContain("Your 2026 Wrapped is ready");
    // No usage on this computer in 2027.
    vi.setSystemTime(new Date("2027-12-11T12:00:00Z"));
    expect(render(live)).not.toContain("Wrapped");
  });

  it("makes Wrapped a reason to publish for everyone else", () => {
    vi.setSystemTime(new Date("2026-12-11T12:00:00Z"));
    const draft = render(status(account, { state: "private", handle: "ada_l" }));
    expect(draft).toContain("Get your 2026 Wrapped");
    expect(draft).toContain("Publish your profile to get yours.");
    expect(draft).not.toContain("Open your Wrapped");
    expect(render(status(null, { state: "signed-out" }))).toContain("Claim a handle to get yours.");
    expect(render(status(account, { state: "missing" }))).toContain("Get your 2026 Wrapped");
    expect(render(status(account, { state: "unknown" }))).not.toContain("Wrapped");
  });

  it("previews the user's own usage on the page", () => {
    const html = render(status(null, { state: "signed-out" }));

    expect(html).toContain("usageatlas.com/@yourname");
    expect(html).toContain("Longest streak");
    expect(html).toContain("gpt-5.6-sol");
  });
});

describe("Profile rail button", () => {
  it("carries a dot until the page is opened", () => {
    const html = shell(true);

    expect(html).toContain('aria-label="Public profile · New"');
    expect(html).toContain('data-badge="true"');
  });

  it("is plain once seen", () => {
    const html = shell(false);

    expect(html).toContain('aria-label="Public profile"');
    expect(html).not.toContain('data-badge="true"');
  });
});

const account = { id: "user_1", email: "ada@example.com" };

function status(signedIn: CloudStatus["account"], profile: CloudProfileStatus): CloudStatus {
  return {
    account: signedIn,
    accountId: signedIn?.id ?? null,
    automatic: true,
    busy: false,
    heldBack: [],
    heldBackCount: 0,
    conflicts: [],
    error: null,
    lastCompleted: null,
    loginCode: null,
    pending: 0,
    profile,
    progress: null
  };
}

/** The fixture has 1,800 tokens in the 30 days before 2026-07-17. */
const glance: LeaderboardGlance = {
  profiles: 12,
  ranked: 3,
  entries: [
    { handle: "ada_l", rank: 1, tokens: 9_000 },
    { handle: "grace", rank: 2, tokens: 1_000 },
    { handle: "linus", rank: 3, tokens: 10 }
  ],
  faces: [
    { handle: "ada_l", name: "Ada L", avatar: "data:image/png;base64,AAAA" },
    { handle: "grace", name: "Grace Hopper", avatar: null }
  ]
};

function render(cloudStatus: CloudStatus | null, leaderboard: LeaderboardGlance | null = null): string {
  const cloud: CloudAccountState = { status: cloudStatus, profile: cloudStatus?.profile ?? null, pending: null, error: null, act: vi.fn() };
  return renderToStaticMarkup(
    <ProfilePage cloud={cloud} leaderboard={leaderboard} onOpenExternal={vi.fn()} onOpenSettings={vi.fn()} snapshot={snapshot} today="2026-07-17" />
  );
}

function shell(profileBadge: boolean): string {
  return renderToStaticMarkup(
    <AppShell engineStatus="ready" noticeCount={0} onNavigate={vi.fn()} profileBadge={profileBadge} route="day">
      <p>Page</p>
    </AppShell>
  );
}
