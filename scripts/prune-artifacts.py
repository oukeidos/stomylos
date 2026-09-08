#!/usr/bin/env python3
"""Keep the installed release and one verified, matched rollback set.

Preview by default. Run with --apply only after successful delivery. Unknown
paths and unique study evidence are not disposable release artifacts.
"""
import argparse
import fcntl
import hashlib
import json
import os
from pathlib import Path
import re
import shutil
import tarfile


def sha(path):
    with path.open('rb') as stream:
        return hashlib.file_digest(stream, 'sha256').hexdigest()


def regular_tree(path):
    if path.is_symlink():
        raise ValueError(f'Symlink refused: {path}')
    if path.is_dir():
        for child in path.iterdir():
            regular_tree(child)
    elif not path.is_file():
        raise ValueError(f'Non-regular artifact refused: {path}')


def bundle_hashes(path):
    regular_tree(path)
    return {str(p.relative_to(path)): sha(p) for p in path.rglob('*') if p.is_file()}


def child(parent, name):
    if Path(name).name != name or name in ('', '.', '..'):
        raise ValueError('Expected a direct child name')
    return parent / name


def plan(root, backup, archive):
    root = root.resolve()
    release = root / 'release'
    for path in (release, backup.parent, backup, archive):
        if path.is_symlink():
            raise ValueError(f'Symlink refused: {path}')
    if archive.parent != release or not re.fullmatch(r'stomylos-linux-x64-\d+\.\d+\.\d+\.tar\.gz', archive.name):
        raise ValueError('Keep an explicit release archive inside product/release')
    if backup.parent.name != 'backups':
        raise ValueError('Keep an explicit matched set inside the data backups directory')
    report = json.loads((backup / 'delivery.json').read_text())
    if report['status'] != 'delivered_and_verified':
        raise ValueError('Delivery is not verified; nothing may be pruned')
    before = child(backup, report.get('backupBundle', 'before-0.18.0-bundle'))
    database = child(backup, report.get('backupDatabase', 'before-v11.sqlite3'))
    regular_tree(backup)
    if bundle_hashes(before) != report['priorFiles'] or sha(database) != report['sourceSha256']:
        raise ValueError('Matched rollback verification failed')
    for name, expected_assets in report.get('assetHashes', {}).items():
        path = child(backup, name)
        actual = bundle_hashes(path) if isinstance(expected_assets, dict) else sha(path)
        if actual != expected_assets:
            raise ValueError('Rollback asset verification failed')
    # Never retain a partial archive or an archive for a different installed app.
    expected = Path(str(archive) + '.sha256').read_text().split()[0]
    if sha(archive) != expected:
        raise ValueError('Archive checksum mismatch')
    active = release / 'linux-unpacked'
    with tarfile.open(archive, 'r:gz') as tar:
        member = next(m for m in tar.getmembers() if m.name.lstrip('./') == 'resources/app.asar')
        if not member.isfile() or hashlib.file_digest(tar.extractfile(member), 'sha256').hexdigest() != sha(active / 'resources/app.asar'):
            raise ValueError('Archive does not match the installed application')
    keep = {active, archive, Path(str(archive) + '.sha256')}
    remove = []
    for path in release.iterdir():
        if path in keep:
            continue
        if (re.fullmatch(r'stomylos-linux-x64-\d+\.\d+\.\d+\.tar\.gz(?:\.sha256)?', path.name)
                or path.name == 'builder-debug.yml'
                or path.is_dir() and (path.name.startswith(('before-', 'linux-unpacked-before-', 'linux-unpacked-rejected-', 'pre-'))
                                     or path.name.endswith(('-candidate', '-final')))):
            remove.append(path)
    backup_pattern = r'(?:before-electron-\d+\.\d+\.\d+-\d+\.sqlite3|electron-\d+\.\d+\.\d+\.json)'
    for path in backup.parent.iterdir():
        if path == backup:
            continue
        if re.fullmatch(backup_pattern, path.name) or path.is_dir() and re.match(
                r'^(?:memory-v\d+-|opening-v\d+-|deletion-v\d+-|time-v\d+-|patterns-v\d+-|search-v\d+-|shared-memory-v\d+-|intention-starters-v\d+-|bookmarks-v\d+-|model-switching-v\d+-|.+-delivery-|deepseek-\d|six-models-)', path.name):
            remove.append(path)
    results = root / 'test-results'
    if results.exists():
        for path in results.iterdir():
            if path.is_dir() and (re.match(r'^(?:model-switching-copy(?:-|$)|bookmark-data-copy-|intention-data-copy-)', path.name)
                                   or path.name in ('shared-memory-copy', 'deepseek-normal-copy')):
                remove.append(path)
        for name in ('typography-rollback/source', 'icon/before'):
            if (results / name).exists():
                remove.append(results / name)
    # Validate the whole removal set before the first mutation, including links
    # in intermediate directories and generated data copies.
    for path in remove:
        for parent in path.parents:
            if parent.is_symlink():
                raise ValueError(f'Symlink ancestor refused: {parent}')
        regular_tree(path)
    return remove


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--root', type=Path, default=Path(__file__).resolve().parents[1])
    parser.add_argument('--backup', type=Path, required=True)
    parser.add_argument('--archive', type=Path, required=True)
    parser.add_argument('--apply', action='store_true')
    args = parser.parse_args()
    backup, archive = args.backup.absolute(), args.archive.absolute()
    # A running app or converter holds an exclusive POSIX lock. Do not remove
    # rollback artifacts while either can be changing normal data.
    lock = os.open(backup.parent.parent / 'stomylos.lock', os.O_RDWR | os.O_NOFOLLOW)
    try:
        fcntl.lockf(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
        remove = plan(args.root, backup, archive)
        report = {'status': 'pruned' if args.apply else 'preview', 'keptBackup': str(backup),
                  'keptArchive': str(archive), 'removed': [str(p) for p in remove]}
        if args.apply:
            results = args.root / 'test-results'
            results.mkdir(exist_ok=True)
            evidence_path = results / 'retired-copy-evidence.json'
            evidence = json.loads(evidence_path.read_text()) if evidence_path.exists() else {}
            for path in remove:
                if results in path.parents and path.is_dir():
                    for record in path.rglob('*.json'):
                        if record.name in ('report.json', 'manifest.json'):
                            evidence[str(record.relative_to(results))] = json.loads(record.read_text())
            evidence_path.write_text(json.dumps(evidence, indent=2) + '\n')
            evidence_path.chmod(0o600)
            for path in remove:
                if path.is_dir():
                    shutil.rmtree(path)
                else:
                    path.unlink()
            (results / 'artifact-retention.json').write_text(json.dumps(report, indent=2) + '\n')
        print(json.dumps(report, indent=2))
    finally:
        os.close(lock)


if __name__ == '__main__':
    main()
