"""Destructive retention checks use disposable trees, never normal user data."""
import fcntl
import hashlib
import json
import os
from pathlib import Path
import subprocess
import tarfile
import tempfile
import unittest

SCRIPT = Path(__file__).resolve().parents[1] / 'scripts/prune-artifacts.py'


class RetentionTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.root = Path(self.tmp.name) / 'product'
        self.release = self.root / 'release'
        self.active = self.release / 'linux-unpacked'
        (self.active / 'resources').mkdir(parents=True)
        (self.active / 'resources/app.asar').write_bytes(b'current app')
        self.data = Path(self.tmp.name) / 'data'
        self.backup = self.data / 'backups/maintenance-delivery-current'
        (self.backup / 'before-0.19.0-bundle/resources').mkdir(parents=True)
        (self.data / 'stomylos.lock').touch()
        (self.data / 'stomylos.sqlite3').write_bytes(b'normal data: never remove')
        (self.backup / 'before-0.19.0-bundle/resources/app.asar').write_bytes(b'prior app')
        (self.backup / 'before-v12.sqlite3').write_bytes(b'prior data')
        self.report = {'status': 'delivered_and_verified', 'backupBundle': 'before-0.19.0-bundle',
                       'backupDatabase': 'before-v12.sqlite3',
                       'sourceSha256': hashlib.sha256(b'prior data').hexdigest(),
                       'priorFiles': {'resources/app.asar': hashlib.sha256(b'prior app').hexdigest()}}
        (self.backup / 'delivery.json').write_text(json.dumps(self.report))
        self.archive = self.release / 'stomylos-linux-x64-0.19.1.tar.gz'
        with tarfile.open(self.archive, 'w:gz') as tar:
            tar.add(self.active, arcname='.')
        Path(str(self.archive) + '.sha256').write_text(hashlib.sha256(self.archive.read_bytes()).hexdigest() + '  archive\n')
        self.old = self.release / 'before-old'
        self.old.mkdir()
        (self.old / 'old.bin').write_bytes(b'old')
        (self.release / 'manual-notes.txt').write_text('keep unknown files')
        (self.data / 'backups/electron-0.19.0.json').write_text('{}')
        (self.data / 'backups/before-electron-0.19.0-123.sqlite3').write_bytes(b'obsolete')
        self.copy = self.root / 'test-results/model-switching-copy-example'
        self.copy.mkdir(parents=True)
        (self.copy / 'stomylos.sqlite3').write_bytes(b'copy')
        (self.copy / 'report.json').write_text('{"status":"passed"}')

    def run_tool(self, apply=True):
        return subprocess.run(['python3', str(SCRIPT), '--root', str(self.root), '--backup', str(self.backup),
                               '--archive', str(self.archive)] + (['--apply'] if apply else []), capture_output=True, text=True)

    def test_preview_then_apply_and_repeat(self):
        self.assertEqual(self.run_tool(False).returncode, 0)
        self.assertTrue(self.old.exists())
        result = self.run_tool()
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertFalse(self.old.exists())
        self.assertFalse(self.copy.exists())
        self.assertEqual(list(self.backup.parent.iterdir()), [self.backup])
        self.assertTrue(self.archive.exists())
        self.assertEqual((self.data / 'stomylos.sqlite3').read_bytes(), b'normal data: never remove')
        self.assertTrue((self.release / 'manual-notes.txt').exists())
        self.assertIn('model-switching-copy-example/report.json', json.loads((self.root / 'test-results/retired-copy-evidence.json').read_text()))
        repeated = self.run_tool()
        self.assertEqual(repeated.returncode, 0, repeated.stderr)
        self.assertEqual(json.loads(repeated.stdout)['removed'], [])

    def test_bad_rollback_prevents_all_deletion(self):
        (self.backup / 'before-v12.sqlite3').write_bytes(b'corrupt')
        self.assertNotEqual(self.run_tool().returncode, 0)
        self.assertTrue(self.old.exists())
        self.assertTrue(self.copy.exists())

    def test_wrong_installed_application_prevents_deletion(self):
        (self.active / 'resources/app.asar').write_bytes(b'different app')
        self.assertNotEqual(self.run_tool().returncode, 0)
        self.assertTrue(self.old.exists())

    def test_symlink_prevents_all_deletion(self):
        (self.old / 'escape').symlink_to(self.data / 'stomylos.sqlite3')
        self.assertNotEqual(self.run_tool().returncode, 0)
        self.assertTrue(self.old.exists())

    def test_running_app_lock_prevents_deletion(self):
        fd = os.open(self.data / 'stomylos.lock', os.O_RDWR)
        try:
            fcntl.lockf(fd, fcntl.LOCK_EX | fcntl.LOCK_NB)
            self.assertNotEqual(self.run_tool().returncode, 0)
            self.assertTrue(self.old.exists())
        finally:
            os.close(fd)


if __name__ == '__main__':
    unittest.main()
