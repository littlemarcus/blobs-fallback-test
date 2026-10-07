// Runs the DAM outage scenario against the deployed site and checks each
// response against what the fallback should do.
//
//   npm run test:fallback
//
// Prints each response, then a pass/fail summary per phase, and exits non-zero
// if any check fails. Full results go to results/run-<timestamp>.json. Netlify
// support can trace any response by its x-nf-request-id.
import { mkdir, writeFile } from "node:fs/promises";

import { admin, loadConfig } from "./config.mjs";

const config = await loadConfig();

const WARM_ASSETS = ["aurora.jpg", "ember.jpg", "cobalt.jpg"];
// Matches the page: every source carries a version, like the DAM's ?v=<hash>.
const VERSION = "1";
const ACCEPTS = { webp: "image/webp,*/*", avif: "image/avif,image/webp,*/*" };
const PURGE_SETTLE_MS = 15_000;
// Longer than the 60-second cache time the function gives a fallback copy.
const FALLBACK_TTL_WAIT_MS = 70_000;

const results = [];
let currentPhase = "";

try {
  await phase("0-reset", "DAM up, no stored copies, empty cache", async () => {
    await control("dam-up");
    await control("clear-copies");
    await control("purge");
    await sleep(PURGE_SETTLE_MS);
  });

  await phase("1-warm", "DAM up, first requests. Expect 200: the function fetches from the DAM and stores a copy", async () => {
    await requestImages(WARM_ASSETS, [384, 640], Object.keys(ACCEPTS), { status: 200 });
  });

  await phase("2-repeat", "DAM up, the same requests. Expect 200 from the edge cache", async () => {
    await requestImages(WARM_ASSETS, [384, 640], Object.keys(ACCEPTS), { status: 200 });
  });

  await phase("3-outage-new-widths", "DAM down, new widths. Expect 200: the source is still in Netlify's cache", async () => {
    await control("dam-down");
    await requestImages(WARM_ASSETS, [828], ["webp"], { status: 200 });
  });

  await phase("4-outage-after-purge", "DAM down, cache purged. Expect 200 from the stored copies", async () => {
    await control("purge");
    await sleep(PURGE_SETTLE_MS);
    await requestImages(WARM_ASSETS, [384, 640, 1080], ["webp"], { status: 200 });
    await requestSources(WARM_ASSETS, VERSION, { status: 200, source: "blobs-fallback" });
    // A version the DAM never served. The last good copy covers it.
    await requestImages(["aurora.jpg"], [640], ["webp"], { status: 200 }, "2");
    await requestSources(["aurora.jpg"], "2", { status: 200, source: "blobs-fallback" });
  });

  await phase("5-outage-never-seen", "DAM down, an image never fetched before. Expect 404: no copy exists", async () => {
    await requestImages(["unwarmed.jpg"], [640], ["webp"], { status: 404 });
  });

  await phase("6-recovered", "DAM up, after the fallback cache time. Expect 200 from the DAM for all", async () => {
    await control("dam-up");
    await sleep(FALLBACK_TTL_WAIT_MS);
    await requestImages([...WARM_ASSETS, "unwarmed.jpg"], [640], ["webp"], { status: 200 });
    await requestSources(["aurora.jpg", "unwarmed.jpg"], VERSION, { status: 200, source: "upstream" });
  });
} finally {
  // Never leave the demo site with the fake DAM down, even after a failure.
  await control("dam-up").catch((err) => console.error(`Could not switch the fake DAM back up: ${err.message}`));
}

await mkdir(new URL("../results/", import.meta.url), { recursive: true });
const file = new URL(`../results/run-${new Date().toISOString().replace(/[:.]/g, "-")}.json`, import.meta.url);
await writeFile(file, JSON.stringify(results, null, 2));
console.log(`\nSaved ${results.length} results to ${file.pathname}`);

console.log("\n== Summary");
let allPassed = true;
for (const id of [...new Set(results.map((row) => row.phase))]) {
  const rows = results.filter((row) => row.phase === id);
  const passed = rows.filter((row) => row.pass).length;
  allPassed &&= passed === rows.length;
  console.log(`${passed === rows.length ? "PASS" : "FAIL"}  ${id}  (${passed}/${rows.length} as expected)`);
}
process.exitCode = allPassed ? 0 : 1;

async function phase(id, title, run) {
  console.log(`\n== ${id}: ${title}`);
  currentPhase = id;
  await run();
}

async function control(action) {
  await admin(config, action);
  console.log(`(admin: ${action})`);
}

// Requests transformed images the way a browser does, through /_next/image.
async function requestImages(assets, widths, formats, expected, version = VERSION) {
  for (const asset of assets) {
    for (const width of widths) {
      for (const format of formats) {
        const url = new URL("/_next/image", config.siteUrl);
        url.searchParams.set("url", `/dam/${asset}?v=${version}`);
        url.searchParams.set("w", String(width));
        url.searchParams.set("q", "75");
        const label = `${asset}?v=${version} w=${width} ${format}`;
        await record({ kind: "image", label, expected }, url, { Accept: ACCEPTS[format] });
      }
    }
  }
}

// Requests the source path itself. Its X-Dam-Source header shows whether the
// image came from the DAM ("upstream") or from the stored copy ("blobs-fallback").
async function requestSources(assets, version, expected) {
  for (const asset of assets) {
    const url = new URL(`/dam/${asset}?v=${version}`, config.siteUrl);
    await record({ kind: "source", label: `${asset}?v=${version} (source)`, expected }, url, {});
  }
}

async function record(meta, url, headers) {
  const res = await fetch(url, { headers });
  const body = await res.arrayBuffer();
  const damSource = res.headers.get("x-dam-source");
  const pass = res.status === meta.expected.status && (!meta.expected.source || damSource === meta.expected.source);
  const row = {
    phase: currentPhase,
    kind: meta.kind,
    label: meta.label,
    expected: meta.expected,
    pass,
    status: res.status,
    bytes: body.byteLength,
    contentType: res.headers.get("content-type"),
    cacheStatus: res.headers.get("cache-status"),
    damSource,
    requestId: res.headers.get("x-nf-request-id"),
  };
  results.push(row);
  console.log(
    `${pass ? "ok  " : "FAIL"} ${String(row.status).padEnd(4)} ${meta.label.padEnd(34)} ${(damSource ?? "").padEnd(15)} | ${row.cacheStatus ?? "-"} | ${row.requestId}`,
  );
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
