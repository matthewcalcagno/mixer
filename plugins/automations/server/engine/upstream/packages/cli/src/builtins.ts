import claude from "@roboplane/extension-claude";
import codex from "@roboplane/extension-codex";
import copilot from "@roboplane/extension-copilot";
import container from "@roboplane/extension-container";
import github from "@roboplane/extension-github";
import jira from "@roboplane/extension-jira";
import opencode from "@roboplane/extension-opencode";
import pi from "@roboplane/extension-pi";
import scheduler from "@roboplane/extension-scheduler";
import scratch from "@roboplane/extension-scratch";
import worktree from "@roboplane/extension-worktree";
import steps from "@roboplane/extension-steps";
import webhooks from "@roboplane/extension-webhooks";
import evaluations from "@roboplane/extension-evaluations";

export const BUILTINS = [
  scheduler,
  scratch,
  worktree,
  container,
  steps,
  webhooks,
  claude,
  codex,
  copilot,
  opencode,
  pi,
  github,
  jira,
  evaluations,
].map((extension) => ({ extension }));
