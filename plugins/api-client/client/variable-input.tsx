import {
  useCallback,
  useId,
  useMemo,
  useRef,
  useState,
  type InputHTMLAttributes,
  type RefObject,
} from "react";
import { VariableToken, useVariableCompletions } from "./variables.js";
interface VariableInputProps extends Omit<InputHTMLAttributes<HTMLInputElement>, "value"> {
  value: string;
  inputRef?: RefObject<HTMLInputElement | null>;
}
export function VariableInput({ value, inputRef, onScroll, ...props }: VariableInputProps) {
  const ownRef = useRef<HTMLInputElement>(null);
  const [scroll, setScroll] = useState(0);
  const id = useId();
  const definitions = useVariableCompletions();
  const hasTokens = /\{\{[^{}]+\}\}/.test(value);
  const scrollInput = useCallback(
    (event: React.UIEvent<HTMLInputElement>) => {
      setScroll(event.currentTarget.scrollLeft);
      onScroll?.(event);
    },
    [onScroll],
  );
  const tokens = useMemo(() => {
    const nodes = [];
    let offset = 0;
    const literal = (text: string) => (props.type === "password" ? "•".repeat(text.length) : text);
    for (const match of value.matchAll(/\{\{\s*([^{}]+?)\s*\}\}/g)) {
      nodes.push(<span key={`text:${offset}`}>{literal(value.slice(offset, match.index))}</span>);
      nodes.push(
        <VariableToken
          key={`variable:${match.index}`}
          name={match[1]!.trim()}
          sensitive={props.type === "password"}
        >
          {match[0]}
        </VariableToken>,
      );
      offset = match.index! + match[0].length;
    }
    nodes.push(<span key={`text:${offset}`}>{literal(value.slice(offset))}</span>);
    return nodes;
  }, [value, props.type]);
  const suggestions = useMemo(() => {
    const start = value.lastIndexOf("{{");
    if (start < 0 || value.slice(start).includes("}}")) return [];
    const query = value
      .slice(start + 2)
      .trim()
      .toLowerCase();
    return definitions
      .filter((item) => item.name.toLowerCase().startsWith(query))
      .slice(0, 30)
      .map((item) => ({
        name: item.name,
        source: item.source,
        insert: `${value.slice(0, start)}{{${item.name}}}`,
      }));
  }, [value, definitions]);
  const mirrorStyle = useMemo(() => ({ transform: `translateX(${-scroll}px)` }), [scroll]);
  return (
    <div className="ac-variable-input" data-highlight={hasTokens}>
      <input
        {...props}
        ref={inputRef ?? ownRef}
        value={value}
        onScroll={scrollInput}
        list={suggestions.length ? id : undefined}
        autoComplete="off"
      />
      {hasTokens && (
        <div className="ac-variable-mirror" aria-hidden="true">
          <div className="ac-variable-text" style={mirrorStyle}>
            {tokens}
          </div>
        </div>
      )}
      {suggestions.length > 0 && (
        <datalist id={id}>
          {suggestions.map((item) => (
            <option key={item.name} value={item.insert}>
              {item.source}
            </option>
          ))}
        </datalist>
      )}
    </div>
  );
}
