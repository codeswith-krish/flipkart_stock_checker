import { acquireProcessLock, releaseProcessLock } from "../../src/modules/checker/process-lock.js";

const lockPath = process.argv[2];
const action = process.argv[3];

if (!lockPath) {
  process.stderr.write("Missing lockPath argument\n");
  process.exit(1);
}

if (action === "acquire-and-hold") {
  const result = acquireProcessLock(lockPath);
  if (result.acquired) {
    process.stdout.write(`ACQUIRED:${result.token}\n`);
    process.stdin.resume();
    process.stdin.on("data", (data) => {
      const cmd = data.toString().trim();
      if (cmd === "RELEASE") {
        if (result.token) {
          releaseProcessLock(lockPath, result.token);
        }
        process.stdout.write("RELEASED\n");
        process.exit(0);
      }
    });
  } else {
    process.stdout.write(`FAILED:${result.reason}\n`);
    process.exit(1);
  }
} else {
  process.stderr.write(`Unknown action: ${action}\n`);
  process.exit(1);
}
