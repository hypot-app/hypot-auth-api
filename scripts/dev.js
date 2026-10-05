// Local development runner: recompiles on change and restarts the app.
// Runs `tsc --watch` and `node --watch` side by side without extra dependencies.
const { spawn, spawnSync } = require('node:child_process');
const { rmSync } = require('node:fs');
const { join } = require('node:path');

const root = join(__dirname, '..');
const tsc = join(root, 'node_modules', 'typescript', 'bin', 'tsc');
const node = process.execPath;

// Remove a stale dist/ (old branches leave compiled migrations behind), then build so dist/
// exists (including email templates) before the app starts.
rmSync(join(root, 'dist'), { recursive: true, force: true });
const build = spawnSync(node, [tsc, '-p', 'tsconfig.build.json'], { cwd: root, stdio: 'inherit' });
if (build.status !== 0) process.exit(build.status ?? 1);
spawnSync(node, [join(__dirname, 'copy-assets.js')], { cwd: root, stdio: 'inherit' });

const children = [
  spawn(node, [tsc, '-p', 'tsconfig.build.json', '--watch', '--preserveWatchOutput'], {
    cwd: root,
    stdio: 'inherit',
  }),
  spawn(node, ['--env-file-if-exists=.env', '--watch-path=dist', 'dist/main.js'], {
    cwd: root,
    stdio: 'inherit',
  }),
];

const shutdown = () => {
  for (const child of children) child.kill('SIGTERM');
};
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
for (const child of children) {
  child.on('exit', (code) => {
    shutdown();
    process.exitCode = code ?? 0;
  });
}
