import { useCallback, useLayoutEffect, useRef, useState, type CSSProperties } from "react";
import { useMutation } from "@tanstack/react-query";

interface InlineRenameProps {
  initialValue: string;
  label: string;
  testID: string;
  onSubmit: (value: string) => Promise<void>;
  onClose: () => void;
  maxLength?: number;
  allowEmpty?: boolean;
}
const containerStyle: CSSProperties = { minWidth: 0, flex: 1 };
const fieldStyle: CSSProperties = {
  width: "100%",
  minWidth: 0,
  boxSizing: "border-box",
  padding: 0,
  font: "inherit",
  color: "inherit",
  background: "transparent",
  border: "1px solid currentColor",
  outlineColor: "var(--mixer-accent)",
  borderRadius: 2,
};

export function InlineRename({
  initialValue,
  label,
  testID,
  onSubmit,
  onClose,
  maxLength,
  allowEmpty = false,
}: InlineRenameProps) {
  const [value, setValue] = useState(initialValue);
  const input = useRef<HTMLInputElement>(null);
  const active = useRef(true);
  const submitting = useRef(false);
  const mutation = useMutation({ mutationFn: onSubmit });
  useLayoutEffect(() => {
    active.current = true;
    input.current?.focus();
    input.current?.select();
    return () => {
      active.current = false;
    };
  }, []);
  const submit = useCallback(async () => {
    if (submitting.current || !active.current) return;
    const title = value.trim();
    if (!allowEmpty && !title) {
      active.current = false;
      onClose();
      return;
    }
    submitting.current = true;
    try {
      await mutation.mutateAsync(title);
      if (active.current) onClose();
    } catch {
      if (active.current) input.current?.focus();
    } finally {
      submitting.current = false;
    }
  }, [mutation, value, onClose, allowEmpty]);
  const stop = useCallback((event: React.SyntheticEvent) => event.stopPropagation(), []);
  const change = useCallback(
    (event: React.ChangeEvent<HTMLInputElement>) => setValue(event.currentTarget.value),
    [],
  );
  const blur = useCallback(() => {
    void submit();
  }, [submit]);
  const key = useCallback(
    (event: React.KeyboardEvent<HTMLInputElement>) => {
      event.stopPropagation();
      if (event.nativeEvent.isComposing) return;
      if (event.key === "Escape") {
        event.preventDefault();
        active.current = false;
        onClose();
      }
      if (event.key === "Enter") {
        event.preventDefault();
        void submit();
      }
    },
    [onClose, submit],
  );
  return (
    <div
      style={containerStyle}
      onPointerDown={stop}
      onMouseDown={stop}
      onClick={stop}
      onDoubleClick={stop}
      onContextMenu={stop}
    >
      <input
        ref={input}
        aria-label={label}
        data-testid={testID}
        style={fieldStyle}
        value={value}
        readOnly={mutation.isPending}
        maxLength={maxLength}
        onChange={change}
        onKeyDown={key}
        onBlur={blur}
        aria-invalid={mutation.isError}
      />
      {mutation.error && <div role="alert">{mutation.error.message}</div>}
    </div>
  );
}
