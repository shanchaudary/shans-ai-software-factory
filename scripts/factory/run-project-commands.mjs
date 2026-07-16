#!/usr/bin/env node
import { loadConfig } from "./config.mjs";
import { githubOutput, invariant, main } from "./lib.mjs";
import { executeCommands } from "./commands.mjs";

await main(async () => {
  const phase = process.env.FACTORY_COMMAND_PHASE;
  const config = await loadConfig(process.env.FACTORY_CONFIG ?? ".ai-factory/project.json");
  const outputPath = process.env.FACTORY_COMMAND_REPORT ?? `${process.env.RUNNER_TEMP ?? "."}/factory-${phase}-report.json`;
  const commands = phase === "setup" ? config.setup_commands : phase === "verify" ? config.verification_commands : null;
  invariant(commands, "INVALID_PHASE", "FACTORY_COMMAND_PHASE must be setup or verify");
  const report = await executeCommands(commands, { phase, outputPath, user: process.env.FACTORY_COMMAND_USER || null });
  await githubOutput("report_path", outputPath);
  await githubOutput("ok", report.ok);
  if (!report.ok) {
    const failed = report.commands.at(-1);
    process.stdout.write(failed.stdout);
    process.stderr.write(failed.stderr);
    process.exitCode = 1;
  }
});
