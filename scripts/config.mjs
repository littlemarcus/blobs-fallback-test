// Shared by the test scripts. Reads SITE_URL and ADMIN_TOKEN from the
// environment, or from .env in the repository root.
import { readFile } from "node:fs/promises";

export const ADMIN_ACTIONS = Object.freeze(["dam-up", "dam-down", "purge", "clear-copies"]);

export async function loadConfig() {
  const env = { ...(await loadDotEnv()), ...process.env };
  if (!env.SITE_URL || !env.ADMIN_TOKEN) {
    console.error("SITE_URL and ADMIN_TOKEN are required (environment or .env). See .env.example.");
    process.exit(1);
  }

  return { siteUrl: env.SITE_URL, adminToken: env.ADMIN_TOKEN };
}

export async function admin(config, action) {
  const res = await fetch(new URL("/admin", config.siteUrl), {
    method: "POST",
    headers: { Authorization: `Bearer ${config.adminToken}`, "Content-Type": "application/json" },
    body: JSON.stringify({ action }),
  });
  if (!res.ok) {
    throw new Error(`admin ${action} failed with status ${res.status}`);
  }
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
