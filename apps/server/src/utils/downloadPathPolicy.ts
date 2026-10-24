import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';

function isContained(root: string, candidate: string): boolean {
  const relative = path.relative(root, candidate);
  return (
    relative === '' ||
    (!relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative))
  );
}

function samePath(left: string, right: string): boolean {
  return path.relative(path.resolve(left), path.resolve(right)) === '';
}

/** Persisted set of directories explicitly selected for downloads. DB rows cannot add roots. */
export class DownloadPathPolicy {
  private readonly roots = new Set<string>();

  constructor(
    private readonly registryFile: string,
    initialRoots: string[],
    private readonly persistChanges = true,
  ) {
    try {
      const value: unknown = JSON.parse(fs.readFileSync(registryFile, 'utf8'));
      if (Array.isArray(value)) {
        for (const root of value) {
          if (typeof root === 'string' && path.isAbsolute(root)) this.addExistingRoot(root);
        }
      }
    } catch {
      // Missing or malformed registry grants no paths; configured roots are added below.
    }
    for (const root of initialRoots) this.approve(root);
  }

  approve(root: string): string {
    const canonical = fs.realpathSync(path.resolve(root));
    if (!fs.statSync(canonical).isDirectory()) throw new Error('Download root must be a directory');
    if (this.roots.has(canonical)) return canonical;
    this.roots.add(canonical);
    if (this.persistChanges) this.persist();
    return canonical;
  }

  resolveAllowedExistingPath(candidate: string): string | null {
    let canonical: string;
    try {
      canonical = fs.realpathSync(candidate);
      if (!fs.statSync(canonical).isDirectory()) return null;
    } catch {
      return null;
    }
    for (const root of this.roots) {
      let canonicalRoot: string;
      try {
        canonicalRoot = fs.realpathSync(root);
      } catch {
        continue;
      }
      if (
        samePath(canonicalRoot, root) &&
        canonical !== canonicalRoot &&
        isContained(canonicalRoot, canonical)
      )
        return canonical;
    }
    return null;
  }

  getApprovedRoots(): string[] {
    return [...this.roots].filter((root) => {
      try {
        return samePath(fs.realpathSync(root), root) && fs.statSync(root).isDirectory();
      } catch {
        return false;
      }
    });
  }

  containsRealPath(root: string, candidate: string): boolean {
    let canonicalRoot: string;
    let canonicalCandidate: string;
    try {
      canonicalRoot = fs.realpathSync(root);
      canonicalCandidate = fs.realpathSync(candidate);
    } catch {
      return false;
    }
    return [...this.roots].some((approved) => {
      try {
        const allowedRoot = fs.realpathSync(approved);
        return (
          samePath(allowedRoot, approved) &&
          isContained(allowedRoot, canonicalRoot) &&
          isContained(allowedRoot, canonicalCandidate)
        );
      } catch {
        return false;
      }
    });
  }

  private addExistingRoot(root: string): void {
    try {
      const canonical = fs.realpathSync(root);
      if (samePath(root, canonical) && fs.statSync(canonical).isDirectory())
        this.roots.add(canonical);
    } catch {
      // A moved or removed directory is retained in the JSON file but is not trusted until it exists.
    }
  }

  private persist(): void {
    fs.mkdirSync(path.dirname(this.registryFile), { recursive: true });
    const temporary = `${this.registryFile}.${process.pid}.${randomUUID()}.tmp`;
    fs.writeFileSync(temporary, JSON.stringify([...this.roots]), { mode: 0o600 });
    fs.renameSync(temporary, this.registryFile);
  }
}
