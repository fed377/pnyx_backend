// The algorithm lives in two places: the app renders against it, the API is
// authoritative for it. They must not drift. Run in CI, or before a release.
import { createHash } from "node:crypto";
import { readFileSync, existsSync } from "node:fs";
import { join } from "node:path";

const FILES = ["algorithm.ts", "grids.ts", "types.ts", "feed.ts", "data.ts"];
const BACKEND = "src/core";
const APP = join("..", "pnyx-native", "src", "lib");

const sha = (p) => createHash("sha256").update(readFileSync(p)).digest("hex").slice(0, 12);

if (!existsSync(APP)) {
  console.log(`No app checkout at ${APP} — nothing to compare against.`);
  process.exit(0);
}

let drifted = 0;
for (const f of FILES) {
  const a = join(BACKEND, f);
  const b = join(APP, f);
  if (!existsSync(b)) {
    console.log(`?  ${f}  (missing in app)`);
    drifted++;
    continue;
  }
  const [x, y] = [sha(a), sha(b)];
  if (x === y) {
    console.log(`ok ${f}  ${x}`);
  } else {
    console.log(`DRIFT ${f}  backend=${x} app=${y}`);
    drifted++;
  }
}

if (drifted) {
  console.error(`\n${drifted} core file(s) out of sync. Copy the intended version across both.`);
  process.exit(1);
}
console.log("\ncore is in sync");
