// The page's image sources carry a version, like the DAM's ?v=<hash>. Next.js
// 16 requires localPatterns for local sources with a query string. "search" is
// left out because the version changes; the DAM proxy function checks it.
export default {
  images: {
    localPatterns: [{ pathname: "/dam/**" }],
  },
};
