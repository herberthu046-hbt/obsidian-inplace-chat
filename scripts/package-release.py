"""Build public ZIPs from explicit release inputs; never copy a personal vault."""
import hashlib
import json
from pathlib import Path
import zipfile

ROOT = Path(__file__).resolve().parents[1]
VERSION = json.loads((ROOT / 'manifest.json').read_text(encoding='utf-8'))['version']
OUTPUT = ROOT / 'release'
OUTPUT.mkdir(exist_ok=True)
STARTER = OUTPUT / 'empty-vault'
if not (STARTER / 'release-manifest.json').exists():
    raise SystemExit('Run npm run build and npm run package:starter first.')

plugin_zip = OUTPUT / f'inplace-chat-{VERSION}.zip'
with zipfile.ZipFile(plugin_zip, 'w', zipfile.ZIP_DEFLATED) as archive:
    for name in ('main.js', 'manifest.json', 'styles.css'):
        archive.write(ROOT / 'dist' / name, 'inplace-chat/' + name)
    archive.write(ROOT / 'distribution/PLUGIN-README.md', 'README.md')
    for name in ('LICENSE', 'scripts/setup-codex-home.ps1'):
        archive.write(ROOT / name, name)

starter_zip = OUTPUT / f'inplace-chat-empty-vault-{VERSION}.zip'
with zipfile.ZipFile(starter_zip, 'w', zipfile.ZIP_DEFLATED) as archive:
    for file in sorted(STARTER.rglob('*')):
        if file.is_file():
            archive.write(file, 'In-place-Chat/' + file.relative_to(STARTER).as_posix())

assets = [ROOT / 'dist' / n for n in ('main.js', 'manifest.json', 'styles.css')]
assets += [plugin_zip, starter_zip]
(OUTPUT / 'SHA256SUMS.txt').write_text(''.join(
    hashlib.sha256(file.read_bytes()).hexdigest() + '  ' + file.name + '\n'
    for file in assets), encoding='utf-8')
print(json.dumps({'version': VERSION, 'assets': [str(p) for p in assets]}, indent=2))
