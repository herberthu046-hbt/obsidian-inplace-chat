const esbuild = require('esbuild');
const fs = require('node:fs');
const path = require('node:path');
const root = path.resolve(__dirname, '..');
fs.mkdirSync(path.join(root, 'dist'), { recursive: true });
esbuild.buildSync({ entryPoints: [path.join(root, 'src/main.cjs')], bundle: true, platform: 'node', format: 'cjs', target: 'es2022', external: ['obsidian', 'electron'], outfile: path.join(root, 'dist/main.js') });
for (const file of ['manifest.json', 'styles.css']) fs.copyFileSync(path.join(root, file), path.join(root, 'dist', file));
