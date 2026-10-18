import type { ReactNode } from "react";
import { useEffect, useRef, useState } from "react";

import { splitDigest } from "./format";
import { Icon } from "./Icon";

/**
 * Copy-to-clipboard affordance for technical values.
 *
 * Digests, skill ids, revisions and subjects are the console's real payload;
 * they are useless if the operator has to select them by hand. The value copied
 * is always the caller's `text`, never the rendered (possibly abbreviated or
 * grouped) display form.
 *
 * `navigator.clipboard` is unavailable in a non-secure context, so a rejection
 * is reported as "Copy failed" instead of silently claiming success. A polite
 * status region announces the outcome without stealing focus.
 */
export function CopyButton({
  text,
  label,
}: {
  readonly text: string;
  readonly label: string;
}): ReactNode {
  const [result, setResult] = useState<"idle" | "ok" | "fail">("idle");
  const timer = useRef<number | undefined>(undefined);

  useEffect(() => () => window.clearTimeout(timer.current), []);

  const copy = (): void => {
    const settle = (next: "ok" | "fail"): void => {
      setResult(next);
      window.clearTimeout(timer.current);
      timer.current = window.setTimeout(() => setResult("idle"), 1500);
    };
    try {
      navigator.clipboard.writeText(text).then(
        () => settle("ok"),
        () => settle("fail"),
      );
    } catch {
      settle("fail");
    }
  };

  const icon = <Icon name="copy" />;
  return (
    <>
      <button
        type="button"
        className={result === "ok" ? "copy is-ok" : "copy"}
        onClick={copy}
        aria-label={`Copy ${label}`}
      >
        {result === "ok" ? "Copied" : result === "fail" ? "Copy failed" : icon}
      </button>
      <span className="visually-hidden" role="status">
        {result === "ok" ? `Copied ${label}` : result === "fail" ? `Could not copy ${label}` : ""}
      </span>
    </>
  );
}

/** A digest rendered as its algorithm prefix plus checkable 8-character groups. */
export function DigestText({ digest }: { readonly digest: string }): ReactNode {
  const { prefix, groups } = splitDigest(digest);
  return (
    <>
      <span className="prefix">{prefix}</span>
      {groups.join(" ")}
    </>
  );
}

/**
 * One copyable technical value.
 *
 * `value` is what the clipboard receives; `display` is what the operator sees.
 * The field is monospace and wraps rather than clipping, so a full digest stays
 * readable on a narrow screen — it is never truncated in the DOM even when the
 * visible form is abbreviated elsewhere on the page.
 */
export function CodeField({
  value,
  display,
  label,
  chunked = false,
  copy = true,
}: {
  readonly value: string;
  readonly display?: ReactNode;
  readonly label: string;
  readonly chunked?: boolean;
  readonly copy?: boolean;
}): ReactNode {
  return (
    <div className={chunked ? "code-field code-field--chunked" : "code-field"}>
      <code title={value}>{display ?? value}</code>
      {copy ? <CopyButton text={value} label={label} /> : null}
    </div>
  );
}
