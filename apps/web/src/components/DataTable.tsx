import type { ReactNode } from "react";

export interface Column<T> {
  /** Stable column key, also used as the stacked-card field label. */
  readonly key: string;
  readonly label: string;
  readonly render: (row: T) => ReactNode;
  /** Right-align and use tabular figures. Use for counts, bytes, digests. */
  readonly numeric?: boolean;
  /** Monospace cell: digests, paths, subjects, operation names. */
  readonly mono?: boolean;
}

export interface DataTableProps<T> {
  /** Visible or screen-reader caption. Required: an unlabelled table is unusable. */
  readonly caption: string;
  readonly columns: readonly Column<T>[];
  readonly rows: readonly T[];
  readonly rowKey: (row: T) => string;
}

/**
 * Dense data table that degrades to stacked cards below 640px.
 *
 * Every cell carries its column label in `data-label`, so the narrow layout can
 * label each field without duplicating the header markup. Nothing here
 * substitutes data: an empty `rows` array renders an explicit "no rows" row
 * rather than a bare `<tbody>`.
 */
export function DataTable<T>({ caption, columns, rows, rowKey }: DataTableProps<T>): ReactNode {
  const monoSet = new Set(columns.filter((column) => column.mono === true).map((column) => column.key));
  return (
    <div className="table-wrap">
      <table className="data-table">
        <caption className="visually-hidden">{caption}</caption>
        <thead>
          <tr>
            {columns.map((column) => (
              <th
                key={column.key}
                scope="col"
                className={column.numeric === true ? "numeric" : undefined}
              >
                {column.label}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.length === 0 ? (
            <tr>
              <td colSpan={columns.length} className="table-empty">
                No rows returned for this query.
              </td>
            </tr>
          ) : (
            rows.map((row) => (
              <tr key={rowKey(row)}>
                {columns.map((column) => (
                  <td
                    key={column.key}
                    data-label={column.label}
                    className={
                      [
                        column.numeric === true ? "numeric" : null,
                        monoSet.has(column.key) ? "mono" : null,
                      ]
                        .filter((value) => value !== null)
                        .join(" ") || undefined
                    }
                  >
                    {column.render(row)}
                  </td>
                ))}
              </tr>
            ))
          )}
        </tbody>
      </table>
    </div>
  );
}

export interface FieldProps {
  readonly label: string;
  readonly children: ReactNode;
  /** Render the value in monospace (digests, subjects, paths). */
  readonly mono?: boolean;
}

/** Key/value row for record detail pages. */
export function Field({ label, children, mono = false }: FieldProps): ReactNode {
  return (
    <div className="field">
      <dt className="field__label">{label}</dt>
      <dd className={mono ? "field__value mono" : "field__value"}>{children}</dd>
    </div>
  );
}