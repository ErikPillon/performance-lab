/**
 * Bundle a service to plain JavaScript for its production image.
 *
 * The images used to run TypeScript directly with `tsx`, which meant every
 * container carried a build tool and its native esbuild binary at runtime —
 * the same binary whose platform mismatch broke the image build until the
 * Dockerfiles moved to `npm ci`. Nothing in production should need it.
 *
 * Workspace packages are bundled; everything from node_modules stays external.
 * That split is not cosmetic: `@lab/db` and friends resolve to `.ts` source
 * through their package.json `main`, so Node cannot load them after
 * compilation and they have to be inlined. Third-party packages are already
 * JavaScript, and bundling them would risk breaking the ones that resolve
 * files at runtime for nothing.
 */
import { build } from 'esbuild';
import { readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const [entry, outfile] = process.argv.slice(2);
if (!entry || !outfile) {
  console.error('usage: node scripts/bundle.mjs <entry.ts> <out.js>');
  process.exit(1);
}

/** Workspace packages, resolved to their TypeScript entry points. */
const workspaces = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')).workspaces ?? [];
const alias = {};
for (const pattern of workspaces) {
  // Patterns are shallow globs like "packages/*"; expand one level.
  const base = pattern.replace(/\/\*$/, '');
  const { readdirSync, existsSync } = await import('node:fs');
  for (const dir of readdirSync(join(root, base), { withFileTypes: true })) {
    if (!dir.isDirectory()) continue;
    const manifest = join(root, base, dir.name, 'package.json');
    if (!existsSync(manifest)) continue;
    const pkg = JSON.parse(readFileSync(manifest, 'utf8'));
    if (pkg.name?.startsWith('@lab/') && pkg.main) {
      alias[pkg.name] = join(root, base, dir.name, pkg.main);
    }
  }
}

const result = await build({
  entryPoints: [resolve(root, entry)],
  outfile: resolve(root, outfile),
  bundle: true,
  platform: 'node',
  // Matches the Dockerfiles' node:22 base.
  target: 'node22',
  format: 'esm',
  sourcemap: true,
  // Keeps the stack traces in a production log readable.
  minify: false,
  alias,
  // Dependencies are bundled in, not left external, so the runtime image needs
  // no node_modules at all. Leaving them external kept dragging tsx into the
  // image through drizzle-kit, which is a dev dependency of @lab/db that npm's
  // workspace resolution installs anyway.
  //
  // Node built-ins stay external by virtue of platform: 'node'.
  // Several dependencies are CommonJS and call require() at runtime. Bundled
  // into an ESM output there is no require in scope, and the first one to try
  // it — postgres.js reaching for node:events — killed the process at boot.
  banner: {
    js: [
      "import { createRequire as __labCreateRequire } from 'node:module';",
      "import { fileURLToPath as __labFileURLToPath } from 'node:url';",
      "import { dirname as __labDirname } from 'node:path';",
      'const require = __labCreateRequire(import.meta.url);',
      'const __filename = __labFileURLToPath(import.meta.url);',
      'const __dirname = __labDirname(__filename);',
    ].join('\n'),
  },
  logLevel: 'warning',
  metafile: true,
});

const bytes = Object.values(result.metafile.outputs)[0]?.bytes ?? 0;
console.log(`bundled ${entry} -> ${outfile} (${(bytes / 1024).toFixed(0)} KB)`);
