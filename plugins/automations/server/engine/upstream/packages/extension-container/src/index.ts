import fs from "node:fs";
import path from "node:path";
import { z } from "zod";
import { defineExtension, type ExecutionContext, type ExecutionProvider, type ProcessAPI, type ProcessRunOptions } from "@mixer/automations-sdk";

const sizeSchema = z.string().regex(/^\d+(?:[bkmg])?$/i);
const digestImage = /@sha256:[a-f0-9]{64}$/;
const environmentName = /^[A-Za-z_][A-Za-z0-9_]*$/;
const reservedEnvironment = /^(?:HOME|TMPDIR|MIXER_AUTOMATIONS_RUN_ID|PATH|DOCKER_.+|CONTAINER_.+|GITHUB_TOKEN|GH_TOKEN|GH_ENTERPRISE_TOKEN|SSH_AUTH_SOCK|AWS_.+|AZURE_.+|GOOGLE_.+|(?:.+_)?(?:TOKEN|SECRET|PASSWORD|CREDENTIAL|API_KEY))$/i;
const hostIntegrationSecret = /^(?:GITHUB_TOKEN|GH_TOKEN|GH_ENTERPRISE_TOKEN|SSH_AUTH_SOCK|AWS_.+|AZURE_.+|GOOGLE_.+|DOCKER_.+|CONTAINER_.+)$/i;

export const containerConfigSchema = z.object({
  runtime: z.enum(["auto", "docker", "podman"]).default("auto"),
  image: z.string().min(1).optional(),
  images: z.record(z.string(), z.string().min(1)).default({}),
  network: z.enum(["none", "bridge"]).default("none"),
  user: z.string().min(1).default("65532:65532"),
  memory: sizeSchema.default("4g"),
  cpus: z.number().positive().default(2),
  pidsLimit: z.number().int().positive().default(256),
  tmpSize: sizeSchema.default("512m"),
}).strict();

type ContainerConfig = z.infer<typeof containerConfigSchema>;

function containerName(runId: string): string {
  return `roboplane-${runId.toLowerCase().replace(/[^a-z0-9_.-]/g, "-").slice(0, 48)}`;
}

function selectedImage(config: ContainerConfig, context: ExecutionContext): string | undefined {
  return config.images[context.agent ?? context.workflow.agent] ?? config.image;
}

function containerCwd(options: ProcessRunOptions, context: ExecutionContext): string {
  if (!context.workspace) return "/workspace";
  const requested = path.resolve(options.cwd ?? context.workspace.path);
  const relative = path.relative(path.resolve(context.workspace.path), requested);
  if (relative === ".." || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
    throw new Error("Container process cwd must be inside the run workspace");
  }
  return relative ? path.posix.join("/workspace", ...relative.split(path.sep)) : "/workspace";
}

function hostCwd(options: ProcessRunOptions, context: ExecutionContext): string | undefined {
  if (!context.workspace) return options.cwd;
  const root = path.resolve(context.workspace.path);
  const requested = path.resolve(options.cwd ?? root);
  const relative = path.relative(root, requested);
  if (relative === ".." || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) throw new Error("Host process cwd must be inside the run workspace");
  return requested;
}

export function buildContainerArgs(
  config: ContainerConfig,
  context: ExecutionContext,
  options: ProcessRunOptions,
): string[] {
  const image = selectedImage(config, context);
  if (!image || !digestImage.test(image)) {
    throw new Error("Container execution requires an image pinned by sha256 digest");
  }
  const args = [
    "run", "--rm", "--init", "--name", containerName(context.run.id),
    "--pull", "never", "--read-only", "--cap-drop", "ALL",
    "--security-opt", "no-new-privileges", "--user", config.user,
    "--pids-limit", String(config.pidsLimit), "--memory", config.memory,
    "--cpus", String(config.cpus), "--network", config.network,
    "--tmpfs", `/tmp:rw,nosuid,nodev,noexec,size=${config.tmpSize}`,
    "--tmpfs", `/home/agent:rw,nosuid,nodev,size=${config.tmpSize}`,
    "--env", "HOME=/home/agent", "--env", "TMPDIR=/tmp",
    "--env", `MIXER_AUTOMATIONS_RUN_ID=${context.run.id}`,
  ];
  if (context.workspace) {
    if (context.workspace.path.includes(",")) throw new Error("Container workspace paths cannot contain commas");
    args.push("--mount", `type=bind,source=${path.resolve(context.workspace.path)},target=/workspace${context.workspaceAccess === "read-only" ? ",readonly" : ""}`);
  } else {
    args.push("--tmpfs", `/workspace:rw,nosuid,nodev,size=${config.tmpSize}`);
  }
  for (const [name, value] of Object.entries(options.env ?? {})) {
    if (value === undefined) continue;
    if (!environmentName.test(name) || value.includes("\0")) throw new Error("Invalid container environment entry");
    if (reservedEnvironment.test(name)) throw new Error(`Container environment name is reserved: ${name}`);
    // Docker and Podman copy the value from their own environment, keeping it out of argv.
    args.push("--env", name);
  }
  args.push("--workdir", containerCwd(options, context), image, options.command, ...(options.args ?? []));
  return args;
}

async function resolveRuntime(api: ProcessAPI, configured: ContainerConfig["runtime"]): Promise<"docker" | "podman"> {
  const candidates = configured === "auto" ? ["podman", "docker"] as const : [configured];
  for (const runtime of candidates) {
    try {
      const result = await api.run({ command: runtime, args: ["version"], inheritEnv: ["PATH"], timeout: 10_000 });
      if (result.exitCode === 0) return runtime;
    } catch {}
  }
  throw new Error(`Container runtime unavailable: ${candidates.join(" or ")}`);
}

export default defineExtension({
  name: "container",
  version: "0.1.0",
  setup(api) {
    const config = containerConfigSchema.parse(api.config.get());

    const host: ExecutionProvider = {
      isolation: "none",
      open(context) {
        return {
          process: {
            run: (options) => {
              const cwd = hostCwd(options, context);
              return api.process.run({
                ...options,
                cwd,
                inheritEnv: ["PATH", "HOME", "USER", "SHELL", "TMPDIR", "LANG", "LC_ALL", "TERM"],
                env: {
                  ...options.env,
                  ...context.workspace?.environment,
                  ...(cwd ? { PWD: cwd } : {}),
                  MIXER_AUTOMATIONS_RUN_ID: context.run.id,
                },
                signal: options.signal ?? context.signal,
              });
            },
          },
          close() {},
        };
      },
    };
    api.executions.register("host", host);
    api.executions.register("unsafe-host", host);

    api.executions.register("proposal-host", {
      isolation: "proposal-only",
      open(context) {
        fs.mkdirSync(api.paths.workspaces, { recursive: true });
        const sessionRoot = fs.mkdtempSync(path.join(api.paths.workspaces, ".proposal-home-"));
        const temporary = path.join(sessionRoot, "tmp");
        fs.mkdirSync(temporary, { recursive: true });
        let closed = false;
        let running = false;
        return {
          process: {
            async run(options) {
              if (closed) throw new Error("Proposal host execution session is closed");
              if (running) throw new Error("Proposal host execution session already has a running process");
              running = true;
              try {
                const explicit = Object.fromEntries(Object.entries(options.env ?? {}).filter(([name, value]) =>
                  value !== undefined && environmentName.test(name) && !hostIntegrationSecret.test(name)));
                const cwd = hostCwd(options, context);
                return await api.process.run({
                  ...options,
                  cwd,
                  inheritEnv: ["PATH", "LANG", "LC_ALL", "TERM"],
                  env: { ...explicit, ...context.workspace?.environment, ...(cwd ? { PWD: cwd } : {}), HOME: sessionRoot, TMPDIR: temporary, MIXER_AUTOMATIONS_RUN_ID: context.run.id },
                  signal: options.signal ?? context.signal,
                });
              } finally {
                running = false;
              }
            },
          },
          close() {
            if (closed) return;
            closed = true;
            fs.rmSync(sessionRoot, { recursive: true, force: true });
          },
        };
      },
    });

    api.executions.register("container", {
      isolation: "isolated",
      validate(workflow) {
        const image = config.images[workflow.agent] ?? config.image;
        if (!image) return [`Container execution requires extensions.container.images.${workflow.agent} or extensions.container.image`];
        if (!digestImage.test(image)) return ["Container image must be pinned with @sha256:<64 lowercase hex characters>"];
        return [];
      },
      async open(context) {
        const runtime = await resolveRuntime(api.process, config.runtime);
        const name = containerName(context.run.id);
        let closed = false;
        let running = false;
        const process: ProcessAPI = {
          async run(options) {
            if (closed) throw new Error("Container execution session is closed");
            if (running) throw new Error("Container execution session already has a running process");
            running = true;
            try {
              return await api.process.run({
                command: runtime,
                args: buildContainerArgs(config, context, options),
                inheritEnv: ["PATH", "DOCKER_HOST", "DOCKER_CONTEXT", "CONTAINER_HOST"],
                env: Object.fromEntries(Object.entries(options.env ?? {}).filter(([name, value]) =>
                  value !== undefined && environmentName.test(name) && !reservedEnvironment.test(name))),
                signal: options.signal ?? context.signal,
                timeout: options.timeout,
                onStdout: options.onStdout,
                onStderr: options.onStderr,
              });
            } finally {
              running = false;
            }
          },
        };
        return {
          process,
          async close() {
            if (closed) return;
            closed = true;
            const result = await api.process.run({
              command: runtime, args: ["rm", "--force", name], inheritEnv: ["PATH", "DOCKER_HOST", "DOCKER_CONTEXT", "CONTAINER_HOST"],
              timeout: 15_000,
            });
            if (result.exitCode !== 0 && !/(?:no such container|no container with name|not found)/i.test(result.stderr)) {
              throw new Error(`${runtime} could not remove ${name}: ${result.stderr}`);
            }
          },
        };
      },
    });
  },
});
