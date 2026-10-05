import { getStore } from "@netlify/blobs";

import { lookupAsset } from "../../lib/assets.mjs";

// The fix under test. Image CDN reads /dam/* as a same-domain source, so a
// cached response here serves every width and format of an image. The
// function only runs when no Netlify cache has the source.
const UPSTREAM_TIMEOUT_MS = 5000;
const CDN_CACHE_UPSTREAM = "public, durable, max-age=31536000";
// Short, so the edge asks the DAM again soon after it recovers.
const CDN_CACHE_FALLBACK = "public, durable, max-age=60";

export default async (req, context) => {
  const asset = lookupAsset(context.params.asset);
  if (!asset) {
    return notFound();
  }

  const copies = getStore("dam-copies");
  const upstream = await fetchFromDam(context.site.url, asset);

  if (upstream) {
    await saveCopy(copies, asset, upstream);
    log(asset, "upstream");
    return imageResponse(upstream.body, upstream.contentType, CDN_CACHE_UPSTREAM, "upstream");
  }

  const copy = await copies.getWithMetadata(asset, { type: "arrayBuffer" }).catch((err) => {
    console.error(JSON.stringify({ msg: "dam copy read failed", asset, error: err.message }));
    return null;
  });

  if (copy) {
    log(asset, "blobs-fallback");
    return imageResponse(copy.data, copy.metadata.contentType, CDN_CACHE_FALLBACK, "blobs-fallback");
  }

  log(asset, "no-copy");
  return notFound();
};

// Returns the image, or null for any failure: error status, timeout, a
// redirect, or a body that is not an image.
async function fetchFromDam(siteUrl, asset) {
  const url = new URL(`/fake-dam/${encodeURIComponent(asset)}`, siteUrl);

  try {
    const res = await fetch(url, { redirect: "error", signal: AbortSignal.timeout(UPSTREAM_TIMEOUT_MS) });
    const contentType = res.headers.get("content-type") ?? "";
    if (!res.ok || !contentType.startsWith("image/")) {
      return null;
    }

    return { body: await res.arrayBuffer(), contentType, etag: res.headers.get("etag") ?? "" };
  } catch {
    return null;
  }
}

// Writes only when the image changed. A failed write still serves the image.
async function saveCopy(copies, asset, upstream) {
  try {
    const existing = await copies.getMetadata(asset);
    if (upstream.etag && existing?.metadata?.etag === upstream.etag) {
      return;
    }

    await copies.set(asset, upstream.body, {
      metadata: { contentType: upstream.contentType, etag: upstream.etag },
    });
  } catch (err) {
    console.error(JSON.stringify({ msg: "dam copy write failed", asset, error: err.message }));
  }
}

function imageResponse(body, contentType, cdnCacheControl, source) {
  return new Response(body, {
    headers: {
      "Content-Type": contentType,
      "Cache-Control": "public, max-age=0, must-revalidate",
      "Netlify-CDN-Cache-Control": cdnCacheControl,
      "X-Dam-Source": source,
    },
  });
}

function notFound() {
  return new Response(null, {
    status: 404,
    headers: { "Cache-Control": "private, no-store", "Netlify-CDN-Cache-Control": "no-store" },
  });
}

function log(asset, source) {
  console.log(JSON.stringify({ msg: "dam proxy", asset, source }));
}

export const config = { path: "/dam/:asset", method: "GET" };
