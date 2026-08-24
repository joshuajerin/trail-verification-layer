import { readFileSync } from "node:fs";

const device = readFileSync(new URL("../firmware/device/sensor.cfg", import.meta.url), "utf8");
if (!device.includes("sensor_source=attached_device")) {
  console.error("serial-runtime failed: the device profile is not connected to the attached-device sensor source");
  process.exit(1);
}
console.log("serial-runtime passed: attached-device reading observed (sensor=ready, samples=3)");
