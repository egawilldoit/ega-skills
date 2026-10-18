import type { ReactNode } from "react";
import { Link, useLocation } from "react-router-dom";

/**
 * Catch-all 404 route.
 *
 * Reports the attempted path verbatim so an operator can tell a bad bookmark
 * from a route that exists but is withheld. It links back to the console root
 * rather than guessing a redirect target.
 */
export function NotFoundPage(): ReactNode {
  const location = useLocation();
  return (
    <section className="state state--unavailable" aria-labelledby="not-found-heading">
      <h2 id="not-found-heading">No such view</h2>
      <p>
        The console has no route for <span className="mono">{location.pathname}</span>.
      </p>
      <p>
        A destination your workspace role cannot read is hidden from navigation rather than
        reported here; if you followed a link that led to this page, the link was built from
        an unknown path.
      </p>
      <p>
        <Link to="/">Console overview</Link>
      </p>
    </section>
  );
}