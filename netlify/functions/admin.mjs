import { createHash, timingSafeEqual } from "node:crypto";

import { getStore } from "@netlify/blobs";
import { purgeCache } from "@netlify/functions";

// Test controls: switch the fake DAM, purge the site cache, and reset the
// Blobs copies. Requires ADMIN_TOKEN (32+ chars) as a bearer token.
const MIN_TOKEN_LENGTH = 32;

export default async (req) => {
  if (!isAuthorized(req)) {
    return Response.json({ error: "unauthorized" }, { status: 401 });
  }

  let action;
  try {
    ({ action } = await req.json());
  } catch {
    return Response.json({ error: "invalid request" }, { status: 400 });
  }

  try {
    switch (action) {
      case "dam-down":
      case "dam-up":
        await getStore({ name: "dam-test", consistency: "strong" }).set("dam-state", action === "dam-down" ? "down" : "up");
        break;
      case "purge":
        await purgeCache();
        break;
      case "clear-copies": {
        const copies = getStore({ name: "dam-copies", consistency: "strong" });
        const { blobs } = await copies.list();
        await Promise.all(blobs.map((blob) => copies.delete(blob.key)));
        break;
      }
      default:
        return Response.json({ error: "invalid request" }, { status: 400 });
    }
  } catch (err) {
    console.error(JSON.stringify({ msg: "admin action failed", action, error: err.message }));
    return Response.json({ error: "internal error" }, { status: 500 });
  }

  return Response.json({ ok: true, action });
};

// Fails closed when the token is missing or too short. Hashing both sides
// gives equal-length buffers, so the comparison takes constant time.
function isAuthorized(req) {
  const expected = Netlify.env.get("ADMIN_TOKEN") ?? "";
  if (expected.length < MIN_TOKEN_LENGTH) {
    return false;
  }

  const header = req.headers.get("authorization") ?? "";
  const given = header.startsWith("Bearer ") ? header.slice("Bearer ".length) : "";

  return timingSafeEqual(sha256(given), sha256(expected));
}

function sha256(value) {
  return createHash("sha256").update(value).digest();
}

export const config = {
  path: "/admin",
  method: "POST",
  rateLimit: { windowLimit: 30, windowSize: 60, aggregateBy: ["ip", "domain"] },
};
