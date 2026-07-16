import { invariant, redact, runShell, runShellAsUser, writeJsonAtomic } from "./lib.mjs";

export async function executeCommands(commands, { cwd = process.cwd(), phase, outputPath, timeoutMs = 30 * 60 * 1000, user = null } = {}) {
  invariant(["setup", "verify"].includes(phase), "INVALID_PHASE", "Command phase must be setup or verify");
  const results = [];
  for (let index = 0; index < commands.length; index += 1) {
    const startedAt = new Date().toISOString();
    const result = user
      ? await runShellAsUser(commands[index], user, { cwd, allowFailure: true, timeoutMs, maxBytes: 32 * 1024 * 1024 })
      : await runShell(commands[index], { cwd, allowFailure: true, timeoutMs, maxBytes: 32 * 1024 * 1024 });
    const record = {
      index,
      command: commands[index],
      started_at: startedAt,
      finished_at: new Date().toISOString(),
      exit_code: result.code,
      stdout: redact(result.stdout),
      stderr: redact(result.stderr),
    };
    results.push(record);
    if (outputPath) await writeJsonAtomic(outputPath, { schema_version: 1, phase, ok: false, commands: results });
    if (result.code !== 0) return { schema_version: 1, phase, ok: false, commands: results };
  }
  const report = { schema_version: 1, phase, ok: true, commands: results };
  if (outputPath) await writeJsonAtomic(outputPath, report);
  return report;
}
