// The only images the fake DAM serves. Requests are resolved against this
// allowlist, never concatenated into a path.
export const ASSET_NAMES = Object.freeze(["aurora.jpg", "ember.jpg", "cobalt.jpg", "unwarmed.jpg"]);

// Shown on the page. "unwarmed.jpg" is left out on purpose: the test requests
// it for the first time during the outage, when no Blobs copy exists yet.
export const PAGE_ASSETS = Object.freeze(["aurora.jpg", "ember.jpg", "cobalt.jpg"]);

export function lookupAsset(name) {
  return typeof name === "string" && ASSET_NAMES.includes(name) ? name : null;
}
