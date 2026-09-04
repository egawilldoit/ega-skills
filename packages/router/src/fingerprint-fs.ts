import { lstatSync, readdirSync, readFileSync } from "node:fs";

export interface LocalDirectoryScan {
  listDirectory(dir: string): string[];
  readFileText(path: string): string | null;
  isRealDirectory(path: string): boolean;
}

/** Local sync filesystem wiring for fingerprintDirectory (EGA-571). */
export const localDirectoryScan: LocalDirectoryScan = {
  listDirectory(dir: string): string[] {
    try {
      return readdirSync(dir);
    } catch {
      return [];
    }
  },
  readFileText(path: string): string | null {
    try {
      return readFileSync(path, "utf8");
    } catch {
      return null;
    }
  },
  isRealDirectory(path: string): boolean {
    try {
      const stat = lstatSync(path);
      return stat.isDirectory() && !stat.isSymbolicLink();
    } catch {
      return false;
    }
  },
};
