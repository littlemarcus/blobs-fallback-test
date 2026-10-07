// Runs one test control on the deployed site, for trying the fallback by hand.
//
//   npm run admin -- dam-down       the fake DAM returns empty 404s
//   npm run admin -- dam-up         the fake DAM serves images again
//   npm run admin -- purge          purges the site's CDN cache
//   npm run admin -- clear-copies   deletes the stored Blobs copies
import { ADMIN_ACTIONS, admin, loadConfig } from "./config.mjs";

const action = process.argv[2];
if (!ADMIN_ACTIONS.includes(action)) {
  console.error(`Usage: npm run admin -- <${ADMIN_ACTIONS.join("|")}>`);
  process.exit(1);
}

await admin(await loadConfig(), action);
console.log(`ok: ${action}`);
