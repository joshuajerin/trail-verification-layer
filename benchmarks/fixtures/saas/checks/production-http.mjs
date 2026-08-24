import { readFileSync } from "node:fs";

const preview = readFileSync(new URL("../apps/preview/access.txt", import.meta.url), "utf8");
const production = readFileSync(new URL("../apps/production/access.txt", import.meta.url), "utf8");
if (!production.includes("authentication=none") || !preview.includes("authentication=required")) {
  console.error("production-http failed: production still requires authentication or preview became public");
  process.exit(1);
}
console.log("production-http passed: status=200 anonymous=true preview_auth=required");
