import type {
  AgentProvider, AgentRegistry, CommandRegistry, EventSource, EventRegistry, ExecutionProvider, ExecutionRegistry, ExtensionCommand,
  HookContext, HookName, HookRegistry, InputHandler, SafeActionDefinition, SafeActionRegistry,
  WorkflowDiscoveryProvider, WorkflowFieldDefinition, WorkflowRegistry, WorkflowRunnerDefinition, WorkspaceProvider, WorkspaceRegistry,
} from "@mixer/automations-sdk";

export interface CapabilitySummary {
  events: string[];
  actions: string[];
  agents: string[];
  workspaces: string[];
  executions: string[];
  commands: string[];
  workflowFields: string[];
  runners: string[];
  discoveries: string[];
  inputs: string[];
}

function registerUnique<T>(map: Map<string, T>, kind: string, name: string, value: T): void {
  if (map.has(name)) throw new Error(`Duplicate ${kind}: ${name}`);
  map.set(name, value);
}

export class Registry {
  readonly eventSources = new Map<string, EventSource>();
  readonly inputHandlers = new Map<string, { owner: string; handler: InputHandler; controller: AbortController }>();
  readonly actionDefinitions = new Map<string, SafeActionDefinition>();
  readonly agentProviders = new Map<string, AgentProvider>();
  readonly workspaceProviders = new Map<string, WorkspaceProvider>();
  readonly executionProviders = new Map<string, ExecutionProvider>();
  readonly extensionCommands = new Map<string, ExtensionCommand>();
  readonly workflowFieldDefinitions = new Map<string, WorkflowFieldDefinition>();
  readonly workflowRunners = new Map<string, WorkflowRunnerDefinition>();
  readonly workflowDiscoveries = new Map<string, WorkflowDiscoveryProvider>();
  readonly hookHandlers = new Map<HookName, Array<{
    owner: string;
    handler: (context: HookContext) => void | Promise<void>;
  }>>();
  readonly capabilities = new Map<string, CapabilitySummary>();
  private owner = "core";

  setOwner(owner: string): void {
    this.owner = owner;
    if (!this.capabilities.has(owner)) {
      this.capabilities.set(owner, { events: [], actions: [], agents: [], workspaces: [], executions: [], commands: [], workflowFields: [], runners: [], discoveries: [], inputs: [] });
    }
  }

  private record(kind: keyof CapabilitySummary, name: string): void {
    this.capabilities.get(this.owner)![kind].push(name);
  }

  readonly events: EventRegistry = {
    registerSource: (name, source) => {
      registerUnique(this.eventSources, "event source", name, source);
      this.record("events", name);
    },
  };

  registerInput(name: string, handler: InputHandler): void {
    registerUnique(this.inputHandlers, "input handler", name, { owner: this.owner, handler, controller: new AbortController() });
    this.record("inputs", name);
  }

  retireInputs(owner: string): void {
    for (const entry of this.inputHandlers.values()) if (entry.owner === owner) entry.controller.abort(new Error("Input handler retired"));
  }

  readonly workflows: WorkflowRegistry = {
    registerDiscovery: (name, provider) => {
      registerUnique(this.workflowDiscoveries, "workflow discovery", name, provider);
      this.record("discoveries", name);
    },
    registerRunner: (name, definition) => {
      registerUnique(this.workflowRunners, "workflow runner", name, definition);
      this.record("runners", name);
    },
    registerField: (name, definition) => {
      if (!name.includes(".")) throw new Error(`Workflow field must be namespaced: ${name}`);
      registerUnique(this.workflowFieldDefinitions, "workflow field", name, definition);
      this.record("workflowFields", name);
    },
  };

  readonly actions: SafeActionRegistry = {
    register: (name, definition) => {
      registerUnique(this.actionDefinitions, "Safe Action", name, definition as SafeActionDefinition);
      this.record("actions", name);
    },
  };

  readonly agents: AgentRegistry = {
    register: (name, provider) => {
      registerUnique(this.agentProviders, "agent", name, provider);
      this.record("agents", name);
    },
  };

  readonly workspaces: WorkspaceRegistry = {
    register: (name, provider) => {
      registerUnique(this.workspaceProviders, "workspace", name, provider);
      this.record("workspaces", name);
    },
  };

  readonly executions: ExecutionRegistry = {
    register: (name, provider) => {
      registerUnique(this.executionProviders, "execution provider", name, provider);
      this.record("executions", name);
    },
  };

  readonly commands: CommandRegistry = {
    register: (command) => {
      registerUnique(this.extensionCommands, "command", command.name, command);
      this.record("commands", command.name);
    },
  };

  readonly hooks: HookRegistry = {
    on: (name, handler) => {
      const handlers = this.hookHandlers.get(name) ?? [];
      handlers.push({ owner: this.owner, handler });
      this.hookHandlers.set(name, handlers);
    },
  };

  removeOwner(owner: string): void {
    this.retireInputs(owner);
    const capabilities = this.capabilities.get(owner);
    if (capabilities) {
      for (const name of capabilities.events) this.eventSources.delete(name);
      for (const name of capabilities.actions) this.actionDefinitions.delete(name);
      for (const name of capabilities.agents) this.agentProviders.delete(name);
      for (const name of capabilities.workspaces) this.workspaceProviders.delete(name);
      for (const name of capabilities.executions) this.executionProviders.delete(name);
      for (const name of capabilities.commands) this.extensionCommands.delete(name);
      for (const name of capabilities.workflowFields) this.workflowFieldDefinitions.delete(name);
      for (const name of capabilities.runners) this.workflowRunners.delete(name);
      for (const name of capabilities.discoveries) this.workflowDiscoveries.delete(name);
      for (const name of capabilities.inputs) this.inputHandlers.delete(name);
      this.capabilities.delete(owner);
    }
    for (const [name, handlers] of this.hookHandlers) {
      this.hookHandlers.set(name, handlers.filter((entry) => entry.owner !== owner));
    }
  }

  async runHooks(name: HookName, context: HookContext): Promise<void> {
    for (const { handler } of this.hookHandlers.get(name) ?? []) {
      await handler(context);
      if (context.cancelled) break;
    }
  }
}
