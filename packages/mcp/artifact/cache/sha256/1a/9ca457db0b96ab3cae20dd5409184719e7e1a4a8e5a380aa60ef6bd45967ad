#!/usr/bin/env bash
# Append one well-formed row to a record-evidence decision log (TSV).
#
# Usage:
#   log.sh <logfile> <phase> <decision> <why> <evidence> <result> \
#          [repository] [base_sha] [head_sha] [environment]
#
# The first six arguments are required. The last four are optional and default
# to empty. The header is written on first use.
set -euo pipefail

if [ "$#" -lt 6 ] || [ "$#" -gt 10 ]; then
	printf 'usage: log.sh <logfile> <phase> <decision> <why> <evidence> <result> [repository] [base_sha] [head_sha] [environment]\n' >&2
	exit 1
fi

logfile="$1"
shift

logdir="$(dirname "$logfile")"
if [ -n "$logdir" ] && [ "$logdir" != "." ] && [ ! -d "$logdir" ]; then
	mkdir -p "$logdir"
fi

# Use `>>` here, never `>`. A network mount can fail a test for a log that
# exists. Then the cost is one stray header line, not the rows.
header='ts\tphase\tdecision\twhy\tevidence\tresult\trepository\tbase_sha\thead_sha\tenvironment'
if [ ! -s "$logfile" ]; then
	printf '%b\n' "$header" >> "$logfile"
fi

ts="$(date -u +%Y-%m-%dT%H:%M:%SZ)"

# Strip tabs, newlines, and CR so each cell stays on one line. Prefix any cell
# whose first character a spreadsheet would parse as a formula (=, +, -, @)
# with a single quote, so generated or user-supplied text cannot execute when a
# reviewer opens the file.
clean() {
	local v
	v=$(printf '%s' "$1" | tr '\t\n\r' '   ')
	case "$v" in
		=*|+*|-*|@*) printf "'%s" "$v" ;;
		*) printf '%s' "$v" ;;
	esac
}

printf '%s\t%s\t%s\t%s\t%s\t%s\t%s\t%s\t%s\t%s\n' \
	"$ts" \
	"$(clean "$1")" \
	"$(clean "$2")" \
	"$(clean "$3")" \
	"$(clean "$4")" \
	"$(clean "$5")" \
	"$(clean "${6-}")" \
	"$(clean "${7-}")" \
	"$(clean "${8-}")" \
	"$(clean "${9-}")" \
	>> "$logfile"
