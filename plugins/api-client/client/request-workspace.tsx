import {
  useCallback,
  useMemo,
  useRef,
  useState,
  type PointerEvent,
  type KeyboardEvent,
} from "react";
import type { ApiRequest } from "../shared/contracts.js";
import { RequestEditor } from "./request-editor.js";
import { ResponseView, type RequestResult } from "./response.js";

function paneLimits(element: HTMLDivElement | null, columns: boolean) {
  if (columns) return { min: 0.25, max: 0.75 };
  const height = element?.getBoundingClientRect().height || 600;
  const header = element?.querySelector(".ac-response-head")?.getBoundingClientRect().height || 38;
  return { min: Math.min(0.25, 36 / height), max: Math.max(0.5, 1 - (header + 7) / height) };
}
/** Both editors share the available space; the divider remains operable without a mouse. */
export function RequestWorkspace({
  request,
  result,
  onChange,
  onError,
  columns,
}: {
  request: ApiRequest;
  result?: RequestResult;
  onChange: (request: ApiRequest) => void;
  onError: (error: string) => void;
  columns: boolean;
}) {
  const root = useRef<HTMLDivElement>(null);
  const [ratio, setRatio] = useState(0.48);
  const collapsed = !columns && ratio === 1;
  const shownRatio = columns ? Math.min(0.75, Math.max(0.25, ratio)) : ratio;
  const style = useMemo(
    () =>
      collapsed
        ? { flexBasis: 0, flexGrow: 1 }
        : { flexBasis: `${shownRatio * 100}%`, flexGrow: 0 },
    [collapsed, shownRatio],
  );
  const position = useCallback(
    (next: number) => {
      const limits = paneLimits(root.current, columns);
      setRatio(
        !columns && next >= limits.max - 0.01
          ? 1
          : Math.min(limits.max, Math.max(limits.min, next)),
      );
    },
    [columns],
  );
  const move = useCallback(
    (event: PointerEvent<HTMLDivElement>) => {
      if (!event.currentTarget.hasPointerCapture(event.pointerId) || !root.current) return;
      const box = root.current.getBoundingClientRect();
      const next = columns
        ? (event.clientX - box.left) / box.width
        : (event.clientY - box.top) / box.height;
      position(next);
    },
    [columns, position],
  );
  const start = useCallback((event: PointerEvent<HTMLDivElement>) => {
    event.preventDefault();
    event.currentTarget.setPointerCapture(event.pointerId);
  }, []);
  const end = useCallback((event: PointerEvent<HTMLDivElement>) => {
    if (event.currentTarget.hasPointerCapture(event.pointerId))
      event.currentTarget.releasePointerCapture(event.pointerId);
  }, []);
  const resize = useCallback(
    (event: KeyboardEvent<HTMLDivElement>) => {
      const backwards = columns ? "ArrowLeft" : "ArrowUp";
      const forwards = columns ? "ArrowRight" : "ArrowDown";
      if (![backwards, forwards, "Home", "End"].includes(event.key)) return;
      event.preventDefault();
      const limits = paneLimits(root.current, columns);
      if (event.key === "Home") position(limits.min);
      else if (event.key === "End") position(columns ? limits.max : 1);
      else
        position(
          (collapsed ? limits.max - 0.1 : shownRatio) + (event.key === forwards ? 0.05 : -0.05),
        );
    },
    [columns, position, collapsed, shownRatio],
  );
  return (
    <div ref={root} className="ac-editor-split" data-columns={columns}>
      <div className="ac-request-pane" style={style}>
        <RequestEditor request={request} onChange={onChange} onError={onError} />
      </div>
      <div
        className="ac-resize-handle"
        role="separator"
        tabIndex={0}
        aria-label="Resize request and response"
        aria-orientation={columns ? "vertical" : "horizontal"}
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuenow={Math.round(shownRatio * 100)}
        onPointerDown={start}
        onPointerMove={move}
        onPointerUp={end}
        onKeyDown={resize}
      >
        <span />
      </div>
      <ResponseView result={result} onError={onError} collapsed={collapsed} />
    </div>
  );
}
