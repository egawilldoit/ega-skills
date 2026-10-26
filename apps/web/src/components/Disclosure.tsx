import type { ReactNode } from "react";
import { useId, useState } from "react";

import { Icon } from "./Icon";

/**
 * Disclosure for detail that is real but secondary.
 *
 * The console keeps every technical value reachable; a disclosure only changes
 * what is on screen first. It is a real button, so it takes focus, announces
 * `aria-expanded`, and points at its own body with `aria-controls`. The body is
 * removed from the layout when collapsed (not merely hidden visually) so a
 * collapsed digest is never half-present to a screen reader or a text search.
 */
export function Disclosure({
  label,
  children,
}: {
  readonly label: string;
  readonly children: ReactNode;
}): ReactNode {
  const [open, setOpen] = useState(false);
  const bodyId = useId();
  return (
    <div className="disc">
      <button
        type="button"
        className="disc__toggle"
        aria-expanded={open}
        aria-controls={bodyId}
        onClick={() => setOpen((previous) => !previous)}
      >
        <Icon name="chevron" />
        {label}
      </button>
      <div className="disc__body" id={bodyId} hidden={!open}>
        {children}
      </div>
    </div>
  );
}
