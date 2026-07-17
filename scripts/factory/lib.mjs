import { appendFile, mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname, resolve, sep } from "node:path";
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";

export class FactoryError extends Error {
  constructor(code, message, details = undefined) {
    super(message);
    this.name = "FactoryError";
    this.code = code;
    this.details = details;
  }
}

export function invariant(condition, code, message, details) {
  if (!condition) throw new FactoryError(code, message, details);
}

export function parsePositiveInteger(value, name, { min = 1, max = Number.MAX_SAFE_INTEGER } = {}) {
  const number = Number(value);
  invariant(Number.isSafeInteger(number) && number >= min && number <= max, "INVALID_INTEGER", `${name} must be an integer between ${min} and ${max}`);
  return number;
}

export async function readJson(path) {
  let text;
  try {
    text = await readFile(path, "utf8");
  } catch (error) {
    throw new FactoryError("READ_FAILED", `Cannot read ${path}: ${error.message}`);
  }
  try {
    return JSON.parse(text);
  } catch (error) {
    throw new FactoryError("INVALID_JSON", `Invalid JSON in ${path}: ${error.message}`);
  }
}

export async function writeJsonAtomic(path, value) {
  await mkdir(dirname(path), { recursive: true });
  const temporary = `${path}.${process.pid}.tmp`;
  await writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
  await rename(temporary, path);
}

export async function writeTextAtomic(path, value) {
  await mkdir(dirname(path), { recursive: true });
  const temporary = `${path}.${process.pid}.tmp`;
  await writeFile(temporary, value, { mode: 0o600 });
  await rename(temporary, path);
}

export function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

export function safeRepoPath(root, candidate) {
  invariant(typeof candidate === "string" && candidate.length > 0 && !candidate.includes("\0"), "UNSAFE_PATH", "Repository path is empty or contains NUL");
  invariant(!candidate.startsWith("/") && !candidate.startsWith("\\"), "UNSAFE_PATH", `Absolute path is not allowed: ${candidate}`);
  const normalizedRoot = resolve(root);
  const absolute = resolve(normalizedRoot, candidate);
  invariant(absolute === normalizedRoot || absolute.startsWith(`${normalizedRoot}${sep}`), "UNSAFE_PATH", `Path escapes repository: ${candidate}`);
  return absolute;
}

export async function githubOutput(name, value) {
  const output = process.env.GITHUB_OUTPUT;
  if (!output) return;
  const marker = `factory_${process.pid}_${Date.now()}_${Math.random().toString(16).slice(2)}`;
  await appendFile(output, `${name}<<${marker}\n${String(value)}\n${marker}\n`, "utf8");
}

export function redact(value) {
  if (typeof value !== "string") return value;
  return value
    .replace(/-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g, "[REDACTED PRIVATE KEY]")
    .replace(/\b(?:gh[oprsu]_[A-Za-z0-9_]{20,}|github_pat_[A-Za-z0-9_]{20,}|sk-[A-Za-z0-9_-]{20,}|AIza[0-9A-Za-z_-]{20,})\b/g, "[REDACTED TOKEN]")
    .replace(/((?:api[_-]?key|token|secret|password)\s*[=:]\s*)[^\s'\"]+/gi, "$1[REDACTED]");
}

export async function run(command, args = [], options = {}) {
  const {
    cwd,
    env = process.env,
    input,
    maxBytes = 16 * 1024 * 1024,
    allowFailure = false,
    timeoutMs = 30 * 60 * 1000,
  } = options;
  return await new Promise((resolvePromise, rejectPromise) => {
    const child = spawn(command, args, { cwd, env, stdio: ["pipe", "pipe", "pipe"] });
    const stdout = [];
    const stderr = [];
    let bytes = 0;
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill("SIGTERM");
      setTimeout(() => child.kill("SIGKILL"), 5000).unref();
    }, timeoutMs);
    const collect = (bucket) => (chunk) => {
      bytes += chunk.length;
      if (bytes > maxBytes) {
        child.kill("SIGTERM");
        rejectPromise(new FactoryError("OUTPUT_LIMIT", `${command} exceeded ${maxBytes} bytes of captured output`));
        return;
      }
      bucket.push(chunk);
    };
    child.stdout.on("data", collect(stdout));
    child.stderr.on("data", collect(stderr));
    child.on("error", (error) => {
      clearTimeout(timer);
      rejectPromise(new FactoryError("PROCESS_START_FAILED", `${command} failed to start: ${error.message}`));
    });
    child.on("close", (code, signal) => {
      clearTimeout(timer);
      const result = {
        code: code ?? 1,
        signal,
        stdout: Buffer.concat(stdout).toString("utf8"),
        stderr: Buffer.concat(stderr).toString("utf8"),
      };
      if (timedOut) return rejectPromise(new FactoryError("PROCESS_TIMEOUT", `${command} timed out after ${timeoutMs}ms`, result));
      if (!allowFailure && result.code !== 0) return rejectPromise(new FactoryError("PROCESS_FAILED", `${command} exited with ${result.code}`, result));
      resolvePromise(result);
    });
    if (input !== undefined) child.stdin.end(input);
    else child.stdin.end();
  });
}

export async function runShell(command, options = {}) {
  invariant(typeof command === "string" && command.trim().length > 0, "INVALID_COMMAND", "Configured command must be a non-empty string");
  return run("bash", ["-euo", "pipefail", "-c", command], options);
}

export function isolatedUserShellArgs(command, cwd) {
  invariant(typeof command === "string" && command.trim().length > 0, "INVALID_COMMAND", "Configured command must be a non-empty string");
  invariant(typeof cwd === "string" && cwd.length > 0 && !cwd.includes("\0"), "INVALID_COMMAND_CWD", "Project command working directory must be a non-empty path");
  return [
    "-euo",
    "pipefail",
    "-c",
    `cd -- "$1"
umask 0002
export GIT_OPTIONAL_LOCKS=0
${command}`,
    "factory-command",
    resolve(cwd),
  ];
}

export async function runShellAsUser(command, user, options = {}) {
  invariant(["factorysetup", "factoryverify"].includes(user), "INVALID_COMMAND_USER", "Project commands may run only as an isolated factory setup or verification user");
  const cwd = options.cwd ?? process.cwd();
  return run("sudo", ["-n", "-u", user, "-H", "--", "bash", ...isolatedUserShellArgs(command, cwd)], options);
}

export function formatError(error) {
  if (error instanceof FactoryError) {
    return JSON.stringify({ ok: false, code: error.code, message: error.message, details: error.details }, null, 2);
  }
  return JSON.stringify({ ok: false, code: "UNEXPECTED", message: error?.stack || String(error) }, null, 2);
}

export async function main(fn) {
  try {
    await fn();
  } catch (error) {
    process.stderr.write(`${formatError(error)}\n`);
    process.exitCode = 1;
  }
}
