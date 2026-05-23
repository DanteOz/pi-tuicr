import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

function uuidv7(): string {
  const timestamp = BigInt(Date.now());
  const bytes = randomBytes(16);

  bytes[0] = Number((timestamp >> 40n) & 0xffn);
  bytes[1] = Number((timestamp >> 32n) & 0xffn);
  bytes[2] = Number((timestamp >> 24n) & 0xffn);
  bytes[3] = Number((timestamp >> 16n) & 0xffn);
  bytes[4] = Number((timestamp >> 8n) & 0xffn);
  bytes[5] = Number(timestamp & 0xffn);
  bytes[6] = (bytes[6] & 0x0f) | 0x70;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;

  const hex = bytes.toString("hex");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

function shellQuote(value: string): string {
  return `'${value.replaceAll("'", `'"'"'`)}'`;
}

function childEnv(): NodeJS.ProcessEnv {
  return {
    ...process.env,
    ...(process.stdout.columns ? { COLUMNS: String(process.stdout.columns) } : {}),
    ...(process.stdout.rows ? { LINES: String(process.stdout.rows) } : {}),
  };
}

function restoreTerminal(cwd: string): void {
  try {
    if (process.stdin.isTTY) process.stdin.setRawMode(false);
  } catch {
    // Best-effort terminal recovery.
  }

  try {
    spawnSync("stty", ["sane"], { cwd, stdio: "ignore" });
  } catch {
    // Best-effort terminal recovery.
  }

  process.stdout.write(
    "\x1b[?1049l\x1b[?1047l\x1b[?47l\x1b[r\x1b[?6l\x1b[?7h\x1b[?25h\x1b[?1000l\x1b[?1002l\x1b[?1003l\x1b[?1006l\x1b[?2004l\x1b[0m\x1b[2J\x1b[H",
  );
}

function commandExists(command: string, cwd: string): boolean {
  const shell = process.env.SHELL || "/bin/sh";
  const result = spawnSync(shell, ["-lc", `command -v ${command}`], {
    cwd,
    env: childEnv(),
    stdio: "ignore",
  });
  return result.status === 0;
}

function isGitRepo(cwd: string): boolean {
  const result = spawnSync("git", ["rev-parse", "--is-inside-work-tree"], {
    cwd,
    env: childEnv(),
    stdio: "ignore",
  });
  return result.status === 0;
}

function runTuicr(cwd: string): { status: number | null; markdown: string | null } {
  const shell = process.env.SHELL || "/bin/sh";
  const tempDir = mkdtempSync(join(tmpdir(), `pi-tuicr-${process.pid}-`));
  const outputPath = join(tempDir, `${uuidv7()}.md`);

  try {
    const result = spawnSync(shell, ["-lc", `tuicr --stdout > ${shellQuote(outputPath)}`], {
      cwd,
      env: childEnv(),
      stdio: "inherit",
    });

    let markdown: string | null = null;
    try {
      const text = readFileSync(outputPath, "utf8").trim();
      markdown = text.length > 0 ? text : null;
    } catch {
      markdown = null;
    }

    return { status: result.status, markdown };
  } finally {
    rmSync(tempDir, { recursive: true, force: true });
  }
}

export default function register(pi: ExtensionAPI): void {
  pi.registerCommand("cr", {
    description: "Run tuicr and put exported review comments into the message box",
    handler: async (_args, ctx): Promise<void> => {
      if (!ctx.hasUI) {
        ctx.ui.notify("/cr requires Pi's interactive TUI.", "error");
        return;
      }

      if (!commandExists("tuicr", ctx.cwd)) {
        ctx.ui.notify("tuicr is not installed or is not on PATH.", "error");
        return;
      }

      if (!isGitRepo(ctx.cwd)) {
        ctx.ui.notify("tuicr must be run from inside a git repository.", "error");
        return;
      }

      let result: { status: number | null; markdown: string | null } | null = null;

      try {
        result = await ctx.ui.custom((tui, theme, _keybindings, done) => {
          setTimeout(() => {
            let completed: { status: number | null; markdown: string | null } = {
              status: null,
              markdown: null,
            };

            tui.stop();
            restoreTerminal(ctx.cwd);

            try {
              completed = runTuicr(ctx.cwd);
            } finally {
              restoreTerminal(ctx.cwd);
              tui.start();
            }

            done(completed);
            tui.requestRender(true);
            setTimeout(() => tui.requestRender(true), 50);
          }, 0);

          return {
            render: (width: number): string[] => [
              theme.fg("accent", "Launching tuicr…".padEnd(Math.min(width, 18))),
            ],
            invalidate: (): void => {},
          };
        });
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        ctx.ui.notify(`Failed to run tuicr: ${message}`, "error");
        return;
      }

      if (!result) return;

      if (result.status !== 0 && result.status !== null) {
        ctx.ui.notify(`tuicr exited with status ${result.status}.`, "warning");
      }

      if (!result.markdown) {
        ctx.ui.notify(
          "No tuicr review was exported. Add comments, then press y or ZZ; q exits without output.",
          "warning",
        );
        return;
      }

      ctx.ui.setEditorText(result.markdown);
    },
  });
}
