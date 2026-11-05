#!/usr/bin/env python3
"""Generate catalog/catalog.json — the static release catalog the launcher reads
instead of the (retired) FPSMaster backend. See catalog/README.md.

Each --client / --launcher argument describes one file that has been (or will be)
uploaded to a GitHub Release; the script hashes the local copy so the launcher
can verify the download.

  --client  PRODUCT[:GAME_VERSION]=LOCAL_FILE@URL      (PRODUCT: edge | nova)
  --edge-aot LOCAL_ZIP@URL                             (Forge-free AOT bundle attached to the edge entry)
  --launcher TARGET=LOCAL_FILE@URL                     (TARGET: windows-x86_64, macos-aarch64, ...)

Example:
  python3 build_catalog.py --revision 2 --edge-version 2.0.0-final --nova-version 1.0.0 --launcher-version 1.0.0 \\
    --client edge=../dist/FPSMaster-Edge-2.0.0-final.jar@https://github.com/FPSMasterTeam/FPSMaster-Edge/releases/download/v2.0.0-final/FPSMaster-Edge-2.0.0-final.jar \\
    --client nova:1.21.11=../dist/fpsmaster-nova-1.21.11-1.0.0.jar@https://github.com/.../fpsmaster-nova-1.21.11-1.0.0.jar \\
    --recommended-nova 1.21.11
"""
import argparse, datetime, hashlib, json, os, sys

def sha256(path):
    h = hashlib.sha256()
    with open(path, 'rb') as f:
        for chunk in iter(lambda: f.read(1 << 20), b''):
            h.update(chunk)
    return h.hexdigest()

def split_spec(spec):
    key, _, rest = spec.partition('=')
    path, _, url = rest.partition('@')
    if not (key and path and url.startswith('https://')):
        sys.exit(f'bad spec (want KEY=FILE@https://URL): {spec}')
    if not os.path.isfile(path):
        sys.exit(f'file not found: {path}')
    return key, path, url

def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument('--revision', type=int, required=True, help='must be higher than the previous catalog')
    ap.add_argument('--edge-version', help='Edge version (required when an edge client is listed)')
    ap.add_argument('--nova-version', help='Nova version (required when a nova client is listed)')
    ap.add_argument('--launcher-version')
    ap.add_argument('--channel', default='release')
    ap.add_argument('--changelog', default='')
    ap.add_argument('--recommended-nova', help='game version marked as recommended')
    ap.add_argument('--client', action='append', default=[])
    ap.add_argument('--launcher', action='append', default=[])
    ap.add_argument('--edge-aot')
    ap.add_argument('--out', default=os.path.join(os.path.dirname(os.path.abspath(__file__)), 'catalog.json'))
    a = ap.parse_args()

    clients = []
    for spec in a.client:
        key, path, url = split_spec(spec)
        product, _, game = key.partition(':')
        product = product.upper()
        if product not in ('EDGE', 'NOVA'):
            sys.exit(f'unknown product {product}')
        if product == 'NOVA' and not game:
            sys.exit('nova entries need a game version: nova:1.21.11=...')
        version = a.edge_version if product == 'EDGE' else a.nova_version
        if not version or not version.strip():
            ap.error(f'{product} needs --{product.lower()}-version')
        clients.append({
            'channel': a.channel,
            'versionType': product,
            'versionName': version.strip(),
            'gameVersion': game or None,
            'artifactSourceType': 'external_url',
            'downloadUrl': url,
            'fileSize': os.path.getsize(path),
            'checksum': sha256(path),
            'recommended': product == 'EDGE' or game == a.recommended_nova,
            'changelog': a.changelog or None,
        })

    if a.edge_aot:
        _, path, url = split_spec('aot=' + a.edge_aot)
        edge = [c for c in clients if c['versionType'] == 'EDGE']
        if not edge:
            sys.exit('--edge-aot needs an edge --client entry')
        edge[0].update({'aotDownloadUrl': url, 'aotFileSize': os.path.getsize(path), 'aotChecksum': sha256(path)})

    launcher = []
    for spec in a.launcher:
        if not a.launcher_version:
            sys.exit('--launcher needs --launcher-version')
        target, path, url = split_spec(spec)
        launcher.append({
            'version': a.launcher_version,
            'target': target,
            'downloadUrl': url,
            'fileSize': os.path.getsize(path),
            'checksum': sha256(path),
            'mandatory': False,
            'notes': a.changelog or None,
        })

    doc = {
        'schema': 1,
        'revision': a.revision,
        'generatedAt': datetime.datetime.now(datetime.timezone.utc).replace(microsecond=0).isoformat(),
        'clients': clients,
        'launcher': launcher,
    }
    with open(a.out, 'w') as f:
        json.dump(doc, f, indent=2, ensure_ascii=False)
        f.write('\n')
    print(f'wrote {a.out}: {len(clients)} client entries, {len(launcher)} launcher entries')

if __name__ == '__main__':
    main()
