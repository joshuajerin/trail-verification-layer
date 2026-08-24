import { readFileSync } from "node:fs";

const notebook = readFileSync(new URL("../models/notebook/provider.txt", import.meta.url), "utf8");
const serving = readFileSync(new URL("../models/serving/provider.txt", import.meta.url), "utf8");
if (!notebook.includes("mode=notebook") || !notebook.includes("provider=fallback") || !serving.includes("mode=production")) {
  console.error("model-tests failed: notebook fallback and production serving identities must be preserved");
  process.exit(1);
}
console.log("model-tests passed");
