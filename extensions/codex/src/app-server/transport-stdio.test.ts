import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { CodexAppServerStartOptions } from "./config.js";
import {
  resolveCodexAppServerSpawnEnv,
  resolveCodexAppServerSpawnInvocation,
} from "./transport-stdio.js";

const tempDirs: string[] = [];

async function createTempDir(): Promise<string> {
  const dir = await mkdtemp(path.join(os.tmpdir(), "openclaw-codex-spawn-"));
  tempDirs.push(dir);
  return dir;
}

afterEach(async () => {
  for (const dir of tempDirs.splice(0)) {
    await rm(dir, { recursive: true, force: true });
  }
});

function startOptions(command: string): CodexAppServerStartOptions {
  return {
    transport: "stdio",
    command,
    args: ["app-server", "--listen", "stdio://"],
    headers: {},
  };
}

describe("resolveCodexAppServerSpawnInvocation", () => {
  it("keeps non-Windows Codex app-server invocation unchanged", () => {
    const resolved = resolveCodexAppServerSpawnInvocation(startOptions("codex"), {
      platform: "darwin",
      env: {},
      execPath: "/usr/local/bin/node",
    });

    expect(resolved).toEqual({
      command: "codex",
      args: ["app-server", "--listen", "stdio://"],
      shell: undefined,
      windowsHide: undefined,
    });
  });

  it("requires managed Codex commands to be resolved before spawn", () => {
    expect(() =>
      resolveCodexAppServerSpawnInvocation(
        {
          ...startOptions("codex"),
          commandSource: "managed",
        },
        {
          platform: "darwin",
          env: {},
          execPath: "/usr/local/bin/node",
        },
      ),
    ).toThrow("must be resolved before spawn");
  });

  it("resolves Windows npm .cmd Codex shims through Node instead of raw spawn", async () => {
    const binDir = await createTempDir();
    const entryPath = path.join(binDir, "node_modules", "@openai", "codex", "bin", "codex.js");
    const shimPath = path.join(binDir, "codex.cmd");
    await mkdir(path.dirname(entryPath), { recursive: true });
    await writeFile(entryPath, "console.log('codex')\n", "utf8");
    await writeFile(
      shimPath,
      '@ECHO off\r\n"%~dp0\\node_modules\\@openai\\codex\\bin\\codex.js" %*\r\n',
      "utf8",
    );

    const resolved = resolveCodexAppServerSpawnInvocation(startOptions("codex"), {
      platform: "win32",
      env: { PATH: binDir, PATHEXT: ".CMD;.EXE;.BAT" },
      execPath: "C:\\node\\node.exe",
    });

    expect(resolved).toEqual({
      command: "C:\\node\\node.exe",
      args: [entryPath, "app-server", "--listen", "stdio://"],
      shell: undefined,
      windowsHide: true,
    });
  });
});

describe("resolveCodexAppServerSpawnEnv", () => {
  it("starts from an inherited runtime allowlist and explicit non-secret overrides", () => {
    expect({
      ...resolveCodexAppServerSpawnEnv(
        {
          env: {
            CODEX_HOME: "/tmp/codex-home",
            KEEP: "override",
          },
        },
        {
          HOME: "/home/agent",
          KEEP: "parent-should-not-inherit",
          PATH: "/usr/bin",
          TMPDIR: "/tmp",
        },
      ),
    }).toEqual({
      CODEX_HOME: "/tmp/codex-home",
      HOME: "/home/agent",
      KEEP: "override",
      PATH: "/usr/bin",
      TMPDIR: "/tmp",
    });
  });

  it("strips SYMPHONY and credential-named variables from the app-server process env", () => {
    expect({
      ...resolveCodexAppServerSpawnEnv(
        {
          env: {
            CODEX_API_KEY: "configured-codex-key",
            CUSTOM_BEARER_TOKEN: "configured-token",
            OPENAI_API_KEY: "configured-openai-key",
            SAFE_FLAG: "configured",
            SYMPHONY_KANBAN_RUNNER_WRITE_KEY: "configured-board-key",
          },
        },
        {
          CODEX_API_KEY: "parent-codex-key",
          HOME: "/home/agent",
          OPENAI_API_KEY: "parent-openai-key",
          PATH: "/usr/bin",
          SYMPHONY_KANBAN_RUNNER_WRITE_KEY: "parent-board-key",
          WEBHOOK_SECRET: "parent-webhook-secret",
        },
      ),
    }).toEqual({
      HOME: "/home/agent",
      PATH: "/usr/bin",
      SAFE_FLAG: "configured",
    });
  });

  it("clears explicitly denied non-secret env vars case-insensitively on Windows", () => {
    expect({
      ...resolveCodexAppServerSpawnEnv(
        {
          env: {
            Other: "configured",
            Temp_Config: "configured-temp",
          },
          clearEnv: ["TEMP_CONFIG", ""],
        },
        {
          Path: "C:\\bin",
          PATHEXT: ".CMD;.EXE;.BAT",
          TEMP: "C:\\Temp",
        },
        "win32",
      ),
    }).toEqual({
      Other: "configured",
      Path: "C:\\bin",
      PATHEXT: ".CMD;.EXE;.BAT",
      TEMP: "C:\\Temp",
    });
  });

  it("uses a null-prototype env map and ignores prototype-polluting keys", () => {
    const overrides = Object.create(null) as Record<string, string | undefined>;
    Object.defineProperty(overrides, "__proto__", {
      value: "polluted",
      enumerable: true,
    });
    Object.defineProperty(overrides, "constructor", {
      value: "polluted",
      enumerable: true,
    });
    Object.defineProperty(overrides, "prototype", {
      value: "polluted",
      enumerable: true,
    });
    overrides.SAFE = "1";

    const env = resolveCodexAppServerSpawnEnv(
      {
        env: overrides as Record<string, string>,
      },
      {
        BASE: "1",
      },
    );

    expect(Object.getPrototypeOf(env)).toBeNull();
    expect({ ...env }).toEqual({
      SAFE: "1",
    });
    expect(Object.hasOwn(env, "__proto__")).toBe(false);
    expect(Object.hasOwn(env, "constructor")).toBe(false);
    expect(Object.hasOwn(env, "prototype")).toBe(false);
  });
});
