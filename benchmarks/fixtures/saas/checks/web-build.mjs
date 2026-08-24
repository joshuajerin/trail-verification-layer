import { readFileSync } from "node:fs";

const preview = readFileSync(new URL("../apps/preview/access.txt", import.meta.url), "utf8");
const production = readFileSync(new URL("../apps/production/access.txt", import.meta.url), "utf8");
if (!preview.includes("surface=preview") || !production.includes("surface=production")) {
  console.error("web-build failed: preview and production surface identities must be preserved");
  process.exit(1);
}
console.log("web-build passed");
