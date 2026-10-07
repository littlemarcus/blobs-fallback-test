# DAM image fallback with Netlify Blobs

This repository is a minimal Next.js site. It shows one way to keep images on a Netlify site working when the image source (a DAM) fails.

## The problem

- Images on the site use the DAM as their source. Netlify Image CDN fetches each source image from the DAM, then resizes and converts it.
- Netlify caches the transformed images at each edge location.
- When an image is not in the cache at a location, Netlify must fetch the source from the DAM again.
- If the DAM fails at that moment, the visitor gets the error. A DAM failure can be an empty `404`, not only a `5xx`. Standard "serve stale on error" features treat a `404` as a valid response, so they do not help.

## The fix

A Netlify Function serves DAM images from your own domain at `/dam/<asset>`. The site's images use `/dam/...` as their source instead of the DAM URL.

```
Browser → Netlify Image CDN → /dam/<asset> (Netlify Function) → DAM
                                     ↕
                              Netlify Blobs (last good copy)
```

1. The function fetches the image from the DAM.
2. If the DAM returns an image, the function stores a copy in Netlify Blobs. It returns the image with a long cache time (`Netlify-CDN-Cache-Control: public, durable, max-age=31536000`).
3. If the DAM fails (error status, timeout, or a response that is not an image), the function returns the stored copy. The copy gets a short cache time (60 seconds), so Netlify asks the DAM again soon after it recovers.
4. If no copy exists, the function returns `404`.

Because Netlify caches the function's response, the function runs only when no Netlify cache has the source image. One cached source serves every width and format of that image.

## What is in this repository

| Path | Purpose |
|---|---|
| `netlify/functions/dam-proxy.mjs` | **The fix.** This is the only file you need in your own site. |
| `app/page.jsx` | A page that shows images with `next/image` and `/dam/...?v=1` sources. |
| `next.config.mjs` | Allows the `?v=` query string on `/dam/` image sources. |
| `netlify/functions/fake-dam.mjs` | Test scaffolding. A fake DAM at `/fake-dam/<asset>` that can be switched to return empty `404` responses. |
| `netlify/functions/admin.mjs` | Test scaffolding. Switches the fake DAM, purges the site cache, and deletes the stored copies. Protected by `ADMIN_TOKEN`. |
| `scripts/run-test.mjs` | Runs the outage test against the deployed site. |
| `scripts/admin.mjs` | Runs one test control, for trying the fallback by hand. |
| `dam-originals/`, `lib/` | The fake DAM's test images. |

## Deploy

You need Node.js 20.9 or later and the Netlify CLI.

1. Install the dependencies:

   ```bash
   npm install
   ```

2. Create a site and link this folder to it:

   ```bash
   netlify sites:create
   ```

3. Create a token of at least 32 characters, and set it for the functions:

   ```bash
   netlify env:set ADMIN_TOKEN "$(node -e 'console.log(require("crypto").randomBytes(32).toString("base64url"))')" --scope functions
   ```

4. Deploy:

   ```bash
   netlify deploy --prod --build
   ```

5. Copy `.env.example` to `.env`. Set `SITE_URL` to your site URL, and `ADMIN_TOKEN` to the token from step 3. To read the token back, use `netlify env:get ADMIN_TOKEN`.

## Run the test

```bash
npm run test:fallback
```

The test takes about 2 minutes. It switches the fake DAM down and up, and purges the site's cache, so do not run it against a site that serves real traffic.

| Phase | Fake DAM | What happens | Expected result |
|---|---|---|---|
| 0 reset | up | Deletes the stored copies and purges the cache | — |
| 1 warm | up | First requests for 3 images, 2 widths, 2 formats | `200`. The function fetches from the DAM and stores a copy. |
| 2 repeat | up | The same requests again | `200`, from the edge cache |
| 3 outage, new widths | **down** | New widths of the same images | `200`. The source image is still in Netlify's cache. |
| 4 outage, cache purged | **down** | Purges the cache, then requests the images. Also requests a version (`?v=2`) that the DAM never served. | `200` for all, from the stored copies |
| 5 outage, new image | **down** | An image that was never fetched before | `404`. No copy exists. |
| 6 recovered | up | Waits 70 seconds, then requests all images | `200`, from the DAM |

Phase 4 is the important one. It is the case that cache headers alone cannot cover: the DAM is down, and the image is not in Netlify's cache.

The script prints one line per request and a pass/fail summary per phase. It exits with a non-zero code if any check fails. It always switches the fake DAM back up at the end, also after a failure. It saves the full results to `results/`.

## Try it by hand

Open the site in a browser, then use these commands to change what the fake DAM does:

```bash
npm run admin -- dam-down       # the fake DAM returns empty 404s
npm run admin -- purge          # empties the site's CDN cache
npm run admin -- dam-up         # the fake DAM serves images again
npm run admin -- clear-copies   # deletes the stored copies
```

For example, to see the fallback:

1. Load the page while the fake DAM is up. The function stores a copy of each image.
2. Run `npm run admin -- dam-down`, then `npm run admin -- purge`.
3. Reload the page. The images still load, from the stored copies.
4. Run `npm run admin -- dam-up` when you are done.

## Reading the results

Two response headers show what happened to a request.

**`X-Dam-Source`** is on responses from `/dam/<asset>`. It shows which branch of the function served the image:

| Value | Meaning |
|---|---|
| `upstream` | The function got the image from the DAM. |
| `blobs-fallback` | The DAM failed, and the function served the stored copy. |

To check it for one image:

```bash
curl -sI "https://<your-site>/dam/aurora.jpg?v=1" | grep -iE "x-dam-source|cache-status"
```

**`Cache-Status`** shows what Netlify's caches did. The common values in this test:

| Value | Meaning |
|---|---|
| `"Netlify Edge"; hit` | Served from the edge cache. Neither the function nor the DAM ran. |
| `"Netlify Edge"; fwd=miss` | Not in the edge cache. Netlify built or fetched the response. |
| `"Netlify Edge"; fwd=stale` | The cached copy had expired, so Netlify checked it again. |
| `"Netlify Durable"; hit` | Served from the durable cache, which all edge locations share. The function did not run. |

Every response also has an `x-nf-request-id` header. The test saves it for each request. Netlify support can use it to trace a response.

## Use the fix with your DAM

1. Copy `netlify/functions/dam-proxy.mjs` into your site's `netlify/functions/` folder. Add `@netlify/blobs` as a dependency.

2. Set `DAM_BASE_URL` to the base URL of your DAM's image path:

   ```bash
   netlify env:set DAM_BASE_URL "https://dam.example.com/api/public/content/" --scope functions
   ```

3. Change your image sources from the DAM URL to `/dam/`:

   ```
   https://dam.example.com/api/public/content/<asset>?v=<version>
   →
   /dam/<asset>?v=<version>
   ```

   The function sends the `v` value on to the DAM. A new version gets a new URL, so a new version is never served from an old cache entry.

4. Next.js 16 requires `images.localPatterns` for local image sources that have a query string. Leave out `search`, because the `v` value changes. The function checks the value itself. See `next.config.mjs` in this repository.

5. Optional: remove the `X-Dam-Source` header from the function. It is only for testing.

## Limits

- **Images that were never fetched successfully have no copy.** During an outage, the function returns `404` for them.
- **The fallback copy is the last good version of the image.** If the DAM fails while a new version is published, visitors see the previous version until the DAM recovers.
- **Response size:** a function response is limited to 6 MB. Very large source images need a different approach.
- **Asset names:** the function accepts letters, digits, `.`, `_`, and `-`, up to 200 characters. Change `ASSET_PATTERN` if your DAM uses other characters.
