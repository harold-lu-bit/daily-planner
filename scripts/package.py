from pathlib import Path
import hashlib
import json
import zipfile

root = Path(__file__).resolve().parents[1]
manifest = json.loads((root / 'manifest.json').read_text())
out = root / 'dist'
out.mkdir(exist_ok=True)
filename = f"{manifest['id']}-{manifest['version']}.zip"
licenses = []
for name in ['yaml', 'zod']:
    folder = root / 'node_modules' / name
    candidates = [p for p in folder.iterdir() if p.name.lower().startswith('license') and p.is_file()]
    if not candidates:
        raise RuntimeError(f'Missing license: {name}')
    licenses.append(name + '\n' + candidates[0].read_text())
with zipfile.ZipFile(out / filename, 'w', zipfile.ZIP_DEFLATED) as bundle:
    for name in ['main.js', 'manifest.json', 'styles.css']:
        bundle.write(root / name, f"{manifest['id']}/{name}")
    for name in ['README.md', 'AGENTS.md', 'docs/VALIDATION.md', 'docs/REQUIREMENTS.md', 'docs/INSTALL.md', 'docs/RELEASING.md', 'examples/Daily.md', 'examples/plugin-settings.example.json']:
        bundle.write(root / name, name)
    bundle.writestr('THIRD-PARTY-LICENSES.txt', '\n\n'.join(licenses))
digest = hashlib.sha256((out / filename).read_bytes()).hexdigest()
(out / 'SHA256SUMS.txt').write_text(f'{digest}  {filename}\n')
print(f'Created dist/{filename} (sha256 {digest})')
