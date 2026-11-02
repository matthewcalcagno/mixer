import { describe, expect, it } from "vitest";
import type { DesktopDialogAskWithCheckboxOptions } from "@/desktop/host";
import { confirmCreateBranch } from "./confirm-create-branch";

describe("new branch native confirmation", () => {
  it("uses Create branch/Cancel and an unchecked push-to-origin checkbox", async () => {
    const calls: Array<{ message: string; options: DesktopDialogAskWithCheckboxOptions }> = [];
    const result = await confirmCreateBranch("feature/new", {
      askWithCheckbox: async (message, options) => {
        calls.push({ message, options });
        return { confirmed: true, dontAskAgain: true };
      },
    });
    expect(calls).toEqual([
      {
        message: "Create a new branch named “feature/new” from the current branch?",
        options: {
          title: "Create branch",
          okLabel: "Create branch",
          cancelLabel: "Cancel",
          kind: "info",
          checkboxLabel: "Push to origin",
          checkboxChecked: false,
        },
      },
    ]);
    expect(result).toEqual({ confirmed: true, pushToOrigin: true });
  });

  it("preserves cancellation and an unchecked checkbox", async () => {
    const result = await confirmCreateBranch("feature/new", {
      askWithCheckbox: async () => ({ confirmed: false, dontAskAgain: false }),
    });
    expect(result).toEqual({ confirmed: false, pushToOrigin: false });
  });
});
