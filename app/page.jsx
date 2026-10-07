import Image from "next/image";

import { PAGE_ASSETS } from "../lib/assets.mjs";

// next/image sources served by Image CDN. The sources are same-domain /dam/*
// paths, so the DAM proxy function serves them. The ?v= value stands in for
// the version hash a DAM adds to its URLs.
export default function Page() {
  return (
    <main>
      {PAGE_ASSETS.map((asset) => (
        <Image key={asset} src={`/dam/${asset}?v=1`} alt={asset} width={640} height={400} />
      ))}
    </main>
  );
}
