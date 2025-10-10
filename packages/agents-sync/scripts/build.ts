import { execSync } from "node:child_process";
import { build } from "tsup";

async function main() {
  await build({
    clean: true,
    dts: true,
    entry: ["src/index.ts"],
    external: ["agents"],
    format: "esm",
    sourcemap: true,
    splitting: true
  });

  execSync("prettier --write ./dist/*.d.ts");

  process.exit(0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
