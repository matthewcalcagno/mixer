// Browser-only test fixture. Not part of either plugin runtime bundle.
import { createRoot } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { SourceControlPanel } from "../client/source-control";
import { SourceControlActivityIcon } from "../client/activity-icon";
import { useRpc } from "@mixer/plugin/client";
import { statusRpc } from "../shared/git";

const colors = {
  surface0: "#171b1e",
  surface1: "#24292f",
  surface2: "#30363d",
  border: "#363d46",
  foreground: "#eff1f4",
  foregroundMuted: "#9da5ae",
  accent: "#387bce",
  accentForeground: "#ffffff",
  statusSuccess: "#b8c2bb",
  statusDanger: "#df7068",
  statusWarning: "#d2ac70",
};
const container = document.getElementById("root");
if (!container) throw new Error("Missing fixture container");
function SidebarFixture() {
  const readStatus = useRpc(statusRpc);
  return (
    <>
      <div style={{ padding: 8 }}>
        <SourceControlActivityIcon
          workspaceId="fixture"
          size={20}
          color={colors.foreground}
          readStatus={readStatus}
        />
      </div>
      <SourceControlPanel
        scope={{ workspaceId: "fixture" }}
        context="workspace"
        host={{ id: "fixture", label: "Fixture" }}
        layout={{ compact: false, platform: "web" }}
        params={{}}
        revision={0}
        tab={{ state: {}, setState() {}, setModified() {}, keepOpen() {} }}
        theme={{ colors }}
        onOpenDiff={() => {}}
      />
    </>
  );
}
createRoot(container).render(
  <QueryClientProvider client={new QueryClient()}>
    <SidebarFixture />
  </QueryClientProvider>,
);
