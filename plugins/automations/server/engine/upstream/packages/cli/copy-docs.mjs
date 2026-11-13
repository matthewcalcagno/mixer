import fs from "node:fs";
import { fileURLToPath } from "node:url";

const source = fileURLToPath(new URL("../../docs", import.meta.url));
const target = fileURLToPath(new URL("./dist/docs", import.meta.url));
const maintainerExamples = fileURLToPath(new URL("../../examples/maintainer", import.meta.url));

fs.rmSync(target, { recursive: true, force: true });
fs.cpSync(source, target, { recursive: true });
const guide = fs.readFileSync(`${maintainerExamples}/README.txt`, "utf8");
fs.writeFileSync(`${target}/maintainer-examples.md`, guide);
for (const file of fs.readdirSync(maintainerExamples).filter((name) => name.endsWith(".md")).sort()) {
  fs.copyFileSync(`${maintainerExamples}/${file}`, `${target}/example-maintainer-${file}`);
}
const scriptedExamples = fileURLToPath(new URL("../../examples/scripted", import.meta.url));
for (const file of fs.readdirSync(scriptedExamples).filter((name) => /\.(md|yaml|yml)$/.test(name)).sort()) {
  const contents = fs.readFileSync(`${scriptedExamples}/${file}`, "utf8");
  const title = file.replace(/\.(md|yaml|yml)$/, "");
  fs.writeFileSync(`${target}/example-scripted-${title}.md`, file.endsWith(".md") ? contents : `# ${title}\n\nSource: examples/scripted/${file}\n\n\`\`\`yaml\n${contents}\`\`\`\n`);
}
const evaluationExample = fileURLToPath(new URL("../../examples/evaluations/issue-triage-comments/evaluation.yaml", import.meta.url));
fs.writeFileSync(`${target}/example-evaluation-issue-triage-comments.md`, `# Issue-triage comment evaluation\n\nCopy this definition to evaluations/issue-triage-comments/evaluation.yaml and select an existing automation.\n\n\`\`\`yaml\n${fs.readFileSync(evaluationExample, "utf8")}\`\`\`\n`);
