/** Tags a website link the app opens, so those visits count as app traffic instead of direct. */
export function fromApp(url: string, campaign: string): string {
  const tagged = new URL(url);
  tagged.searchParams.set("utm_source", "desktop_app");
  tagged.searchParams.set("utm_medium", "app");
  tagged.searchParams.set("utm_campaign", campaign);
  return tagged.toString();
}
