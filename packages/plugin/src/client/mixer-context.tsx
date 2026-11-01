import type { MixerApi } from "@mixer/client";
import { createContext, useContext, type ReactNode } from "react";

const MixerApiContext = createContext<MixerApi | null>(null);

export function useMixerContextValue(): MixerApi | null {
  return useContext(MixerApiContext);
}

export function MixerApiProvider({ children, mixer }: { children: ReactNode; mixer: MixerApi }) {
  return <MixerApiContext.Provider value={mixer}>{children}</MixerApiContext.Provider>;
}

export function useMixer(): MixerApi {
  const mixer = useMixerContextValue();
  if (!mixer) throw new Error("useMixer must run inside a contributed plugin surface");
  return mixer;
}
