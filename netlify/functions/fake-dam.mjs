import { getStore } from "@netlify/blobs";

import { lookupAsset } from "../../lib/assets.mjs";
import { ORIGINALS } from "../../lib/originals.mjs";

// Stands in for the Sitecore DAM. It sends the DAM's headers, and the admin
// function can switch it to the empty 404s seen in the real outage.
// Netlify never caches it, so a switch takes effect on the next request.
const DAM_OK_CACHE_CONTROL = "public, must-revalidate, max-age=600";
const DAM_404_CACHE_CONTROL = "max-age=14400";

export default async (req, context) => {
  const asset = lookupAsset(context.params.asset);
  const state = await getStore({ name: "dam-test", consistency: "strong" }).get("dam-state");

  if (!asset || state === "down") {
    return new Response(null, {
      status: 404,
      headers: { "Cache-Control": DAM_404_CACHE_CONTROL, "Netlify-CDN-Cache-Control": "no-store" },
    });
  }

  const original = ORIGINALS[asset];
  return new Response(Buffer.from(original.base64, "base64"), {
    headers: {
      "Content-Type": "image/jpeg",
      ETag: original.etag,
      "Cache-Control": DAM_OK_CACHE_CONTROL,
      "Netlify-CDN-Cache-Control": "no-store",
    },
  });
};

export const config = { path: "/fake-dam/:asset", method: "GET" };
