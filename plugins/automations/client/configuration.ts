import { useQuery } from "@tanstack/react-query";
import { useRpc } from "@mixer/plugin/client";
import { configurationInfoRpc } from "../shared/contracts.js";

export function useConfiguration() {
  const info = useRpc(configurationInfoRpc);
  return useQuery({
    queryKey: ["automations", "configuration"],
    queryFn: () => info({}),
    refetchInterval: 2_000,
  });
}
