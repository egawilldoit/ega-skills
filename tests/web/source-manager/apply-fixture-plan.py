"""Apply a trusted planner fixture to a disposable source-catalog copy."""
import json
import pathlib
import sys

root = pathlib.Path(sys.argv[1]).resolve(strict=True)
changes = json.loads(pathlib.Path(sys.argv[2]).read_text(encoding="utf-8"))
for name, content in changes.items():
    path = pathlib.PurePosixPath(name)
    if path.is_absolute() or ".." in path.parts or "\\" in name:
        raise ValueError("unsafe fixture path")
    target = root.joinpath(*path.parts)
    if not target.resolve().is_relative_to(root):
        raise ValueError("fixture path escapes candidate")
    if content is None:
        target.unlink()
        parent = target.parent
        while parent != root:
            try:
                parent.rmdir()
            except OSError:
                break
            parent = parent.parent
    elif isinstance(content, str):
        target.parent.mkdir(parents=True, exist_ok=True)
        target.write_text(content, encoding="utf-8")
    else:
        raise ValueError("fixture must contain text changes only")
