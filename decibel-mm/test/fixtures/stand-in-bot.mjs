// A stand-in for `cli.ts <command>` used by the supervisor tests. It records every start and then behaves as
// scripted by STANDIN_SCRIPT: a comma-separated list of exit codes, one per start ("hang" = run until SIGTERM, then exit 0).
import { appendFileSync, readFileSync, writeFileSync, existsSync } from "node:fs";
const [, , command] = process.argv;
const dir = process.env.STANDIN_DIR;
const attempt = Number(process.env.MM_SUPERVISED_ATTEMPT ?? 0);
appendFileSync(`${dir}/starts.log`, `${command} ${attempt} ${process.argv.slice(3).join(" ")}\n`);
const script = (process.env.STANDIN_SCRIPT ?? "0").split(",");
const step = command === "live" ? script[Math.min(attempt - 1, script.length - 1)] : "0";
if (step === "hang") {
  process.on("SIGTERM", () => {
    appendFileSync(`${dir}/starts.log`, `sigterm ${attempt}\n`);
    process.exit(0);
  });
  setInterval(() => {}, 1000);
} else {
  process.exit(Number(step));
}
