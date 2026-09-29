// 测试运行器：用 vite 自带的 esbuild 把 TS 测试打成 CJS，再交给 node --test。
import { build } from "esbuild";
import { rmSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const outDir = resolve(root, ".test-build");

rmSync(outDir, { recursive: true, force: true });

await build({
  entryPoints: [resolve(root, "src/dispatch/dispatch.test.ts")],
  bundle: true,
  platform: "node",
  format: "cjs",
  outfile: resolve(outDir, "dispatch.test.cjs"),
  logLevel: "warning"
});

const result = spawnSync(process.execPath, ["--test", outDir], {
  stdio: "inherit",
  cwd: root
});
process.exit(result.status ?? 1);
