import { readFileSync } from "node:fs";

const device = readFileSync(new URL("../firmware/device/sensor.cfg", import.meta.url), "utf8");
const simulator = readFileSync(new URL("../firmware/simulator/sensor.cfg", import.meta.url), "utf8");
if (!device.includes("board=stm32") || !simulator.includes("board=simulator")) {
  console.error("firmware-build failed: the device and simulator board identities must be preserved");
  process.exit(1);
}
console.log("firmware-build passed");
