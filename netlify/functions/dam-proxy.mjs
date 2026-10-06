import { getStore } from "@netlify/blobs";

// Serves DAM images from your own domain at /dam/<asset> and keeps a copy of
// each one in Netlify Blobs. When the DAM fails, it serves the stored copy.
//
// Image CDN reads /dam/* as a same-domain source, so one cached response here
// serves every width and format of an image. The function only runs when no
// Netlify cache has the source image.
//
// DAM_BASE_URL sets the DAM to read from, for example
// "https://dam.example.com/api/public/content/". Without it, the function
// reads from this site's fake DAM at /fake-dam/.
const UPSTREAM_TIMEOUT_MS = 5000;
const CDN_CACHE_UPSTREAM = "public, durable, max-age=31536000";
// Short, so the edge asks the DAM again soon after it recovers.
const CDN_CACHE_FALLBACK = "public, durable, max-age=60";

// Asset names and version values are checked against these patterns before
// they are used in the upstream URL or as a Blobs key.
const ASSET_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,199}$/;
const VERSION_PATTERN = /^[A-Za-z0-9]{1,64}$/;

export default async (req, context) => {
  const asset = context.params.asset;
  const version = new URL(req.url).searchParams.get("v");
  if (!ASSET_PATTERN.test(asset ?? "") || (version !== null && !VERSION_PATTERN.test(version))) {
    return notFound();
  }

  // One copy per asset, for any version: during an outage the last good
  // image is better than none.
  const copies = getStore("dam-copies");
  const upstream = await fetchFromDam(damUrl(context.site.url, asset, version));

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

function damUrl(siteUrl, asset, version) {
  const base = Netlify.env.get("DAM_BASE_URL") || new URL("/fake-dam/", siteUrl).href;
  const url = new URL(encodeURIComponent(asset), base.endsWith("/") ? base : `${base}/`);
  if (version !== null) {
    url.searchParams.set("v", version);
  }

  return url;
}

// Returns the image, or null for any failure: an error status (including the
// 404s a failing DAM can send), a timeout, a redirect, or a body that is not
// an image.
async function fetchFromDam(url) {
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
      // Shows which branch served the image. Safe to remove in production.
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
