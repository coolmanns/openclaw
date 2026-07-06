import { spawn } from "node:child_process";
import {
  materializeWindowsSpawnProgram,
  resolveWindowsSpawnProgram,
} from "openclaw/plugin-sdk/windows-spawn";
import type { CodexAppServerStartOptions } from "./config.js";
import type { CodexAppServerTransport } from "./transport.js";

const UNSAFE_ENVIRONMENT_KEYS = new Set(["__proto__", "constructor", "prototype"]);
const ALLOWED_INHERITED_ENVIRONMENT_KEYS = new Set([
  "APPDATA",
  "CI",
  "COLORTERM",
  "COMSPEC",
  "FORCE_COLOR",
  "HOME",
  "HOMEDRIVE",
  "HOMEPATH",
  "LANG",
  "LC_ALL",
  "LC_CTYPE",
  "LOCALAPPDATA",
  "LOGNAME",
  "NODE_ENV",
  "PATH",
  "PATHEXT",
  "PROCESSOR_ARCHITECTURE",
  "PROGRAMDATA",
  "PROGRAMFILES",
  "PROGRAMFILES(X86)",
  "SHELL",
  "SYSTEMDRIVE",
  "SYSTEMROOT",
  "TEMP",
  "TERM",
  "TMP",
  "TMPDIR",
  "USER",
  "USERPROFILE",
  "WINDIR",
  "XDG_RUNTIME_DIR",
]);
const CREDENTIAL_ENVIRONMENT_KEY_RE =
  /(^|_)(API_?KEY|AUTH|BEARER|COOKIE|CREDENTIALS?|PASSWORD|PASS|PRIVATE_?KEY|SECRET|SESSION|TOKEN)(_|$)/i;

type CodexAppServerSpawnRuntime = {
  platform: NodeJS.Platform;
  env: NodeJS.ProcessEnv;
  execPath: string;
};

const DEFAULT_SPAWN_RUNTIME: CodexAppServerSpawnRuntime = {
  platform: process.platform,
  env: process.env,
  execPath: process.execPath,
};

export function resolveCodexAppServerSpawnInvocation(
  options: CodexAppServerStartOptions,
  runtime: CodexAppServerSpawnRuntime = DEFAULT_SPAWN_RUNTIME,
): { command: string; args: string[]; shell?: boolean; windowsHide?: boolean } {
  if (options.commandSource === "managed") {
    throw new Error("Managed Codex app-server start options must be resolved before spawn.");
  }
  const program = resolveWindowsSpawnProgram({
    command: options.command,
    platform: runtime.platform,
    env: runtime.env,
    execPath: runtime.execPath,
    packageName: "@openai/codex",
  });
  const resolved = materializeWindowsSpawnProgram(program, options.args);
  return {
    command: resolved.command,
    args: resolved.argv,
    shell: resolved.shell,
    windowsHide: resolved.windowsHide,
  };
}

export function resolveCodexAppServerSpawnEnv(
  options: Pick<CodexAppServerStartOptions, "env" | "clearEnv">,
  baseEnv: NodeJS.ProcessEnv = process.env,
  platform: NodeJS.Platform = process.platform,
): NodeJS.ProcessEnv {
  const env = Object.create(null) as NodeJS.ProcessEnv;
  copyAllowedInheritedEnvironmentEntries(env, baseEnv, platform);
  copyExplicitEnvironmentEntries(env, options.env ?? {});
  const keysToClear = normalizedEnvironmentKeys(options.clearEnv ?? []);
  if (platform === "win32") {
    const lowerCaseKeysToClear = new Set(keysToClear.map((key) => key.toLowerCase()));
    for (const candidate of Object.keys(env)) {
      if (lowerCaseKeysToClear.has(candidate.toLowerCase())) {
        delete env[candidate];
      }
    }
  } else {
    for (const key of keysToClear) {
      delete env[key];
    }
  }
  return env;
}

function normalizedEnvironmentKeys(rawKeys: readonly string[]): string[] {
  const keys: string[] = [];
  for (const rawKey of rawKeys) {
    const key = rawKey.trim();
    if (key.length > 0) {
      keys.push(key);
    }
  }
  return keys;
}

function copyAllowedInheritedEnvironmentEntries(
  target: NodeJS.ProcessEnv,
  source: NodeJS.ProcessEnv | Record<string, string | undefined>,
  platform: NodeJS.Platform,
): void {
  for (const [key, value] of Object.entries(source)) {
    if (!isSafeEnvironmentEntry(key) || isCredentialEnvironmentKey(key)) {
      continue;
    }
    const normalizedKey = platform === "win32" ? key.toUpperCase() : key;
    if (!ALLOWED_INHERITED_ENVIRONMENT_KEYS.has(normalizedKey)) {
      continue;
    }
    target[key] = value;
  }
}

function copyExplicitEnvironmentEntries(
  target: NodeJS.ProcessEnv,
  source: NodeJS.ProcessEnv | Record<string, string | undefined>,
): void {
  for (const [key, value] of Object.entries(source)) {
    if (!isSafeEnvironmentEntry(key) || isCredentialEnvironmentKey(key)) {
      continue;
    }
    target[key] = value;
  }
}

function isSafeEnvironmentEntry(key: string): boolean {
  return !UNSAFE_ENVIRONMENT_KEYS.has(key);
}

function isCredentialEnvironmentKey(key: string): boolean {
  return key.toUpperCase().startsWith("SYMPHONY_") || CREDENTIAL_ENVIRONMENT_KEY_RE.test(key);
}

export function createStdioTransport(options: CodexAppServerStartOptions): CodexAppServerTransport {
  const env = resolveCodexAppServerSpawnEnv(options);
  const invocation = resolveCodexAppServerSpawnInvocation(options, {
    platform: process.platform,
    env,
    execPath: process.execPath,
  });
  return spawn(invocation.command, invocation.args, {
    env,
    detached: process.platform !== "win32",
    shell: invocation.shell,
    stdio: ["pipe", "pipe", "pipe"],
    windowsHide: invocation.windowsHide,
  });
}
