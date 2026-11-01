import type { ResolveStreamRenderStrategyInput, StreamStrategy } from "./strategy";
import { createWebStreamStrategy } from "./strategy-web";
export function resolveStreamRenderStrategy(
  input: ResolveStreamRenderStrategyInput,
): StreamStrategy {
  return createWebStreamStrategy({
    isMobileBreakpoint: input.isMobileBreakpoint,
  });
}
