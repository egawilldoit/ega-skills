import type { ReactNode } from "react";
import { Link } from "react-router-dom";

import { formatTimestampUtc } from "./format";
import { Icon, type IconName } from "./Icon";

/**
 * A single measured total, shown with the moment it was measured.
 *
 * The value is always a number the BFF returned. There is no default, no zero
 * fallback, and no trend, delta, or sparkline: the console has no historical
 * series for these counts, so it does not draw one. When `snapshotAt` is null
 * the card says the timestamp was not recorded rather than omitting the line
 * and implying the number is live.
 */
export function StatCard({
  label,
  value,
  snapshotAt,
  icon,
  accent = false,
  href,
}: {
  readonly label: string;
  readonly value: number;
  readonly snapshotAt: string | null;
  readonly icon: IconName;
  readonly accent?: boolean;
  readonly href?: string;
}): ReactNode {
  const body = (
    <>
      <div className="stat__head">
        <span className={accent ? "tile tile--blue" : "tile"}>
          <Icon name={icon} />
        </span>
        {label}
        {href === undefined ? null : <Icon name="arrow" />}
      </div>
      <div className="stat__num">{value.toLocaleString("en-US")}</div>
      <div className="stat__snap">
        Snapshot{" "}
        {snapshotAt === null ? (
          <span>time not recorded</span>
        ) : (
          <time dateTime={snapshotAt} title={snapshotAt}>
            {formatTimestampUtc(snapshotAt)}
          </time>
        )}
      </div>
    </>
  );

  if (href !== undefined) {
    return (
      <Link className="card stat" to={href}>
        {body}
      </Link>
    );
  }
  return <div className="card stat">{body}</div>;
}
