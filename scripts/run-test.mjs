// Runs the DAM outage scenario against a deployed site and records each
// response. Reads SITE_URL and ADMIN_TOKEN from the environment or .env.
//
//   node scripts/run-test.mjs
//
// Prints each response, then a pass/fail summary per phase. Full results go
// to results/run-<timestamp>.json. Netlify support can trace any response by
// its x-nf-request-id.
import { mkdir, readFile, writeFile } from "node:fs/promises";

const env = { ...(await loadDotEnv()), ...process.env };
const SITE_URL = env.SITE_URL;
const ADMIN_TOKEN = env.ADMIN_TOKEN;
if (!SITE_URL || !ADMIN_TOKEN) {
  console.error("SITE_URL and ADMIN_TOKEN are required (environment or .env)");
  process.exit(1);
}

const WARM_ASSETS = ["aurora.jpg", "ember.jpg", "cobalt.jpg"];
const ACCEPTS = { webp: "image/webp,*/*", avif: "image/avif,image/webp,*/*" };
const PURGE_SETTLE_MS = 15_000;
const FALLBACK_TTL_WAIT_MS = 70_000;

const results = [];
let current = "";

await phase("0-reset", "Reset: DAM up, no Blobs copies, empty cache", async () => {
  await admin("dam-up");
  await admin("clear-copies");
  await admin("purge");
  await sleep(PURGE_SETTLE_MS);
});

await phase("1-warm", "DAM up, first requests (expect 200, transform misses)", async () => {
  await requestImages(WARM_ASSETS, [384, 640], Object.keys(ACCEPTS), 200);
});

await phase("2-repeat", "DAM up, same requests (expect 200, edge hits)", async () => {
  await requestImages(WARM_ASSETS, [384, 640], Object.keys(ACCEPTS), 200);
});

await phase("3-outage-new-widths", "DAM down, new widths (expect 200, source from Netlify cache)", async () => {
  await admin("dam-down");
  await requestImages(WARM_ASSETS, [828], ["webp"], 200);
});

await phase("4-outage-after-purge", "DAM down, cache purged (expect 200 from the Blobs copy)", async () => {
  await admin("purge");
  await sleep(PURGE_SETTLE_MS);
  await requestImages(WARM_ASSETS, [384, 640, 1080], ["webp"], 200);
  await requestDirect(WARM_ASSETS, 200);
});

await phase("5-outage-never-seen", "DAM down, image never fetched before (expect 404, no copy)", async () => {
  await requestImages(["unwarmed.jpg"], [640], ["webp"], 404);
});

await phase("6-recovered", "DAM up after the fallback TTL (expect 200 for all)", async () => {
  await admin("dam-up");
  await sleep(FALLBACK_TTL_WAIT_MS);
  await requestImages([...WARM_ASSETS, "unwarmed.jpg"], [640], ["webp"], 200);
  await requestDirect(["aurora.jpg", "unwarmed.jpg"], 200);
});

await mkdir(new URL("../results/", import.meta.url), { recursive: true });
const file = new URL(`../results/run-${new Date().toISOString().replace(/[:.]/g, "-")}.json`, import.meta.url);
await writeFile(file, JSON.stringify(results, null, 2));
console.log(`\nSaved ${results.length} results to ${file.pathname}`);

console.log("\n== Summary");
for (const id of [...new Set(results.map((row) => row.phase))]) {
  const rows = results.filter((row) => row.phase === id);
  const failed = rows.filter((row) => row.status !== row.expected).length;
  console.log(`${failed === 0 ? "PASS" : "FAIL"}  ${id}  (${rows.length - failed}/${rows.length} as expected)`);
}

async function phase(id, title, run) {
  console.log(`\n== ${id}: ${title}`);
  current = id;
  await run();
}


async function requestImages(assets, widths, formats, expected) {
  for (const asset of assets) {
    for (const width of widths) {
      for (const format of formats) {
        const url = new URL("/_next/image", SITE_URL);
        url.searchParams.set("url", `/dam/${asset}`);
        url.searchParams.set("w", String(width));
        url.searchParams.set("q", "75");
        await record({ kind: "image", asset, width, format, expected }, url, { Accept: ACCEPTS[format] });
      }
    }
  }
}

// Requests the source path itself, to read which branch the proxy took.
async function requestDirect(assets, expected) {
  for (const asset of assets) {
    await record({ kind: "source", asset, expected }, new URL(`/dam/${asset}`, SITE_URL), {});
  }
}

async function record(meta, url, headers) {
  const res = await fetch(url, { headers });
  const body = await res.arrayBuffer();
  const row = {
    phase: current,
    ...meta,
    status: res.status,
    bytes: body.byteLength,
    contentType: res.headers.get("content-type"),
    cacheStatus: res.headers.get("cache-status"),
    damSource: res.headers.get("x-dam-source"),
    requestId: res.headers.get("x-nf-request-id"),
  };
  results.push(row);
  const label = meta.kind === "image" ? `${meta.asset} w=${meta.width} ${meta.format}` : `${meta.asset} (source)`;
  const mark = row.status === meta.expected ? "ok  " : "FAIL";
  console.log(`${mark} ${String(row.status).padEnd(4)} ${label.padEnd(30)} ${row.damSource ?? ""} | ${row.cacheStatus ?? "-"} | ${row.requestId}`);
}

async function admin(action) {
  const res = await fetch(new URL("/admin", SITE_URL), {
    method: "POST",
    headers: { Authorization: `Bearer ${ADMIN_TOKEN}`, "Content-Type": "application/json" },
    body: JSON.stringify({ action }),
  });
  if (!res.ok) {
    throw new Error(`admin ${action} failed with status ${res.status}`);
  }
  console.log(`(admin: ${action})`);
}

async function loadDotEnv() {
  try {
    const text = await readFile(new URL("../.env", import.meta.url), "utf8");
    return Object.fromEntries(
      text
        .split("\n")
        .map((line) => line.trim())
        .filter((line) => line && !line.startsWith("#") && line.includes("="))
        .map((line) => [line.slice(0, line.indexOf("=")), line.slice(line.indexOf("=") + 1)]),
    );
  } catch {
    return {};
  }
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
