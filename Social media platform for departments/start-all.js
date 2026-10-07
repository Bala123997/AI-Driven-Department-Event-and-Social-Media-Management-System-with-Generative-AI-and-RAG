#!/usr/bin/env node
/**
 * Starts both the Vite dev server and API server simultaneously
 * Usage: npm run start-all
 */

import { spawn } from "child_process";
import path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

console.log("🚀 Starting CSE Social Platform...\n");

// Start API server
console.log("📡 Starting API server...");
const apiProcess = spawn("node", ["api/server.js"], {
  cwd: __dirname,
  stdio: "inherit",
  shell: true,
});

// Start dev server
setTimeout(() => {
  console.log("\n🎨 Starting Vite dev server...");
  const devProcess = spawn("npm", ["run", "dev"], {
    cwd: __dirname,
    stdio: "inherit",
    shell: true,
  });

  devProcess.on("error", (err) => {
    console.error("❌ Dev server error:", err);
    process.exit(1);
  });
}, 2000);

apiProcess.on("error", (err) => {
  console.error("❌ API server error:", err);
  process.exit(1);
});

process.on("SIGINT", () => {
  console.log("\n🛑 Shutting down servers...");
  apiProcess.kill();
  process.exit(0);
});
