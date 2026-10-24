import { readFile, readdir, stat } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const markdownFiles = [];

async function collectMarkdown(directory) {
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const fullPath = path.join(directory, entry.name);
    if (entry.isDirectory()) await collectMarkdown(fullPath);
    else if (entry.isFile() && entry.name.endsWith('.md')) markdownFiles.push(fullPath);
  }
}

async function collectPackageNames(directory) {
  const names = new Set();
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    try {
      const manifest = JSON.parse(
        await readFile(path.join(directory, entry.name, 'package.json'), 'utf8'),
      );
      if (typeof manifest.name === 'string') names.add(manifest.name);
    } catch (error) {
      if (error?.code !== 'ENOENT') throw error;
    }
  }
  return names;
}

function decodeTarget(target) {
  return decodeURIComponent(target.split(/[?#]/, 1)[0].replace(/^<|>$/g, ''));
}

async function main() {
  await collectMarkdown(path.join(root, 'docs'));
  markdownFiles.push(path.join(root, 'README.md'), path.join(root, 'CONTRIBUTING.md'));
  const packageNames = new Set([
    ...(await collectPackageNames(path.join(root, 'apps'))),
    ...(await collectPackageNames(path.join(root, 'packages'))),
  ]);
  const failures = [];

  for (const file of markdownFiles) {
    const content = await readFile(file, 'utf8');
    const linkPattern = /\[[^\]]*\]\(([^)]+)\)/g;
    for (const match of content.matchAll(linkPattern)) {
      const raw = match[1].trim().split(/\s+/, 1)[0];
      if (!raw || /^(?:[a-z][a-z\d+.-]*:|\/\/|#)/i.test(raw)) continue;
      const target = path.resolve(path.dirname(file), decodeTarget(raw));
      try {
        await stat(target);
      } catch {
        failures.push(`${path.relative(root, file)}: missing link target ${raw}`);
      }
    }

    for (const match of content.matchAll(/--workspace(?:=|\s+)([^\s`]+)/g)) {
      const name = match[1];
      if (name.startsWith('<') || name.endsWith('>')) continue;
      if (!packageNames.has(name))
        failures.push(`${path.relative(root, file)}: unknown workspace ${name}`);
    }
  }

  if (failures.length) {
    console.error(failures.join('\n'));
    process.exitCode = 1;
  } else {
    console.log(
      `Checked links and workspace references in ${markdownFiles.length} Markdown files.`,
    );
  }
}

await main();
