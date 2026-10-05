import Image from "next/image";

import { PAGE_ASSETS } from "../lib/assets.mjs";

// Same pattern as the customer: next/image sources served by Image CDN. The
// sources are same-domain /dam/* paths, so the DAM proxy function serves them.
export default function Page() {
  return (
    <main>
      {PAGE_ASSETS.map((asset) => (
        <Image key={asset} src={`/dam/${asset}`} alt={asset} width={640} height={400} />
      ))}
    </main>
  );
}
