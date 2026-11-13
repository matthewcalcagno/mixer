import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { Runtime, parseWorkflow, validateWorkflow } from "@roboplane/core";
import { BUILTINS } from "./builtins.js";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
describe("executable scripted documentation", () => {
  it("validates every scripted example and complete YAML documentation block with the real registry", async () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), "roboplane-scripted-docs-"));
    const runtime = new Runtime({ home, builtins: BUILTINS });
    try {
      await runtime.initialize();
      const examples = path.join(root, "examples", "scripted");
      for (const file of fs.readdirSync(examples)) {
        const workflow = parseWorkflow(path.join(examples, file), examples, runtime.registry);
        expect(validateWorkflow(workflow, runtime.registry), file).toEqual([]);
      }
      let checked = 0;
      for (const topic of ["scripted-workflows", "workflow-handoffs", "github"]) {
        const source = fs.readFileSync(path.join(root, "docs", `${topic}.md`), "utf8");
        for (const block of source.matchAll(/```yaml\n([\s\S]*?)```/g)) {
          const text = block[1]; if (!text || !/^on:/m.test(text) || !/^steps:/m.test(text)) continue;
          const file = path.join(home, "automations", `block-${checked++}.yaml`); fs.writeFileSync(file, text);
          expect(validateWorkflow(parseWorkflow(file, path.join(home, "automations"), runtime.registry), runtime.registry), `${topic}:${checked}`).toEqual([]);
        }
      }
      expect(checked).toBe(4);
    } finally { await runtime.stop(); fs.rmSync(home, { recursive: true, force: true }); }
  });
});
