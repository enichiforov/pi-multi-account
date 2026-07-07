import { readdir } from "node:fs/promises";
import { spawn } from "node:child_process";
import { join } from "node:path";

const testsDir = new URL("../tests/", import.meta.url);
const files = (await readdir(testsDir))
  .filter((file) => file.endsWith(".mjs"))
  .sort();

if (files.length === 0) {
  console.error("No test files found in tests/*.mjs");
  process.exit(1);
}

for (const file of files) {
  const relative = join("tests", file);
  console.log(`== ${relative}`);
  const result = await new Promise((resolve) => {
    const child = spawn(process.execPath, [relative], {
      cwd: new URL("..", import.meta.url),
      stdio: "inherit",
    });
    child.on("exit", (code, signal) => resolve({ code, signal }));
  });

  if (result.code !== 0) {
    console.error(`${relative} failed${result.signal ? ` with signal ${result.signal}` : ""}`);
    process.exit(result.code ?? 1);
  }
}

console.log(`All ${files.length} test files passed.`);
