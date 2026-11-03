import childProcess from "node:child_process";

const child = childProcess.spawn(process.execPath, ["src/server.js"], {
  stdio: "inherit",
  env: process.env,
});

let shuttingDown = false;
let childExit = null;

child.on("exit", (code, signal) => {
  childExit = { code, signal };
  if (!shuttingDown) {
    process.exit(code ?? (signal ? 1 : 0));
  }
});

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function shutdown(signal) {
  if (shuttingDown) return;
  shuttingDown = true;

  console.log(`[supervisor] received ${signal}; forwarding to wrapper...`);

  try {
    if (!childExit) child.kill(signal);
  } catch {
    // ignore
  }

  const startedAt = Date.now();

  // Wait for the wrapper to exit first. Its SIGTERM handler forwards SIGTERM
  // to the OpenClaw Gateway child. Keeping the container alive briefly after
  // wrapper exit gives the Gateway time to release its persisted owner lease.
  while (!childExit && Date.now() - startedAt < 10_000) {
    await sleep(100);
  }

  if (childExit) {
    console.log("[supervisor] wrapper exited; allowing Gateway cleanup window...");
    await sleep(5_000);
  } else {
    console.warn("[supervisor] wrapper did not exit within shutdown window");
  }

  console.log("[supervisor] shutdown complete");
  process.exit(0);
}

process.on("SIGTERM", () => {
  void shutdown("SIGTERM");
});

process.on("SIGINT", () => {
  void shutdown("SIGINT");
});
