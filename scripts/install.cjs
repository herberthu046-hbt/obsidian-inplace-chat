const fs = require('node:fs');
const path = require('node:path');
const root = path.resolve(__dirname, '..');
const vault = process.argv[2];
if (!vault || !fs.existsSync(path.join(vault, '.obsidian'))) throw new Error('Usage: npm run install:vault -- <vault path>');
const destination = path.join(path.resolve(vault), '.obsidian', 'plugins', 'inplace-chat');
const files = ['main.js', 'manifest.json', 'styles.css'];
for (const file of files) {
  if (!fs.existsSync(path.join(root, 'dist', file))) throw new Error(`Missing dist/${file}; run npm run build first.`);
}
const manifest = JSON.parse(fs.readFileSync(path.join(root, 'dist/manifest.json'), 'utf8'));
if (manifest.id !== 'inplace-chat') throw new Error('Unexpected plugin id in build.');
fs.mkdirSync(destination, { recursive: true });
const previous = files.filter(file => fs.existsSync(path.join(destination, file)));
if (previous.length) {
  const backup = path.join(destination, '.installation', new Date().toISOString().replace(/[:.]/g, '-'));
  fs.mkdirSync(backup, { recursive: true });
  for (const file of previous) fs.copyFileSync(path.join(destination, file), path.join(backup, file));
  console.log('Previous plugin files backed up:', backup);
}
for (const file of files) {
  const target = path.join(destination, file), staging = `${target}.installing`;
  fs.copyFileSync(path.join(root, 'dist', file), staging);
  fs.renameSync(staging, target);
}
console.log(`Installed In-place Chat ${manifest.version}:`, destination, '\nEnable or reload In-place Chat in Obsidian. Existing settings and vault data are preserved.');
