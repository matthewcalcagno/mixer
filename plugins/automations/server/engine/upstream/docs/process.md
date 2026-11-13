# Processes

Harnesses and steps run through `ctx.execution.run` in the attested checkout or scratch directory. The host provider fixes `cwd` and `PWD`, records `MIXER_AUTOMATIONS_RUN_ID`, and applies trusted workspace environment such as the publication guard. It inherits filtered ordinary execution variables, not integration tokens. Scripts cannot override reserved guard, shell-startup, Git, or run-context variables.

`ProcessRunOptions` supports command, argv, cwd, environment overrides, cancellation, total timeout, no-output timeout, and stdout/stderr callbacks. Stdin is always closed for unattended execution.

Harness output is streamed to the run log. A non-zero exit, total timeout, or no-output timeout fails the run.

Script output streams with step and attempt identifiers and uses `captureOutput: false` to avoid accumulating a copy in memory. On POSIX hosts, timeout and cancellation terminate the process group and escalate to SIGKILL, including shell descendants. Stdin remains closed.
