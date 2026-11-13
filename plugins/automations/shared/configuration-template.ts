export const initialAutomationConfiguration = `${JSON.stringify(
  {
    runtime: { mode: "managed" },
    history: { retention: "1d" },
    extensions: {
      jira: { baseUrl: "https://jira.example.com", token: "${JIRA_TOKEN}" },
      scheduler: {},
      worktree: {},
      opencode: { env: { GITHUB_TOKEN: "${GITHUB_TOKEN}", JIRA_TOKEN: "${JIRA_TOKEN}" } },
      github: {
        token: "${GITHUB_TOKEN}",
        pollInterval: "5m",
        publishGuard: { enabled: true, maxChangedFiles: null },
        failureReports: { enabled: false },
      },
    },
  },
  null,
  2,
)}\n`;
