import type { ReactNode } from "react";
import { Link, useLocation } from "react-router-dom";

import { Icon } from "../components/Icon";

/**
 * Catch-all 404 route.
 *
 * Reports the attempted path verbatim so an operator can tell a bad bookmark
 * from a route that exists but is withheld. It links back to the console root
 * rather than guessing a redirect target.
 *
 * It renders the same state card the resource states use, so a 404 is visually
 * the same class of thing as any other "nothing here" answer instead of a
 * differently-shaped box.
 */
export function NotFoundPage(): ReactNode {
  const location = useLocation();
  return (
    <section
      className="card state state-card state--unavailable"
      aria-labelledby="not-found-heading"
    >
      <span className="tile">
        <Icon name="warn" />
      </span>
      <h3 id="not-found-heading">No such view</h3>
      <p>
        The console has no route for <span className="mono">{location.pathname}</span>.
      </p>
      <p>
        A destination your workspace role cannot read is hidden from navigation rather than
        reported here; if you followed a link that led to this page, the link was built from
        an unknown path.
      </p>
      <div className="actions">
        <Link className="button" to="/">
          Console overview
        </Link>
      </div>
    </section>
  );
}
