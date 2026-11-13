import { defineExtension } from "@mixer/automations-sdk";

export default defineExtension({
  name: "hello",
  setup(api) {
    api.commands.register({
      name: "hello",
      description: "Print a greeting",
      run(args) {
        console.log(`Hello ${args[0] ?? "Mixer Automations"}`);
      },
    });
  },
});
