// Starts the fake Twilio server, the web server and the worker together (for tests and local dev).
// In production these run as separate processes: `npm start` and `npm run worker`.
import { spawn } from "node:child_process";

const dev = process.env.NUDGE_DEV === "1";
const run = (name, args) => {
  const child = spawn(process.execPath, args, { stdio: "inherit", env: process.env });
  child.on("exit", (code) => {
    console.error(`[${name}] exited with ${code}`);
    shutdown(code ?? 1);
  });
  return child;
};

const children = [];
if (process.env.FAKE_TWILIO !== "0") children.push(run("fake-twilio", ["scripts/fake-twilio.mjs"]));
children.push(run("server", dev ? ["--import", "tsx", "src/server.ts"] : ["dist/server.js"]));
children.push(run("worker", dev ? ["--import", "tsx", "src/worker.ts"] : ["dist/worker.js"]));

let closing = false;
function shutdown(code) {
  if (closing) return;
  closing = true;
  for (const c of children) c.kill("SIGTERM");
  setTimeout(() => process.exit(code), 500);
}
process.on("SIGINT", () => shutdown(0));
process.on("SIGTERM", () => shutdown(0));
