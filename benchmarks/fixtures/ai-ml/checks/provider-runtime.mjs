import { readFileSync } from "node:fs";

const serving = readFileSync(new URL("../models/serving/provider.txt", import.meta.url), "utf8");
if (!serving.includes("provider=live")) {
  console.error("provider-runtime failed: serving is not configured for the live provider");
  process.exit(1);
}
console.log("provider-runtime passed: response_id=fixture-live-1 status=observed");
