"""Check cross-process admission and the GC probe deadline."""
import importlib.util
import multiprocessing
import os
from pathlib import Path
import subprocess
import sys
import tempfile
import time
import unittest


def load(name):
    spec = importlib.util.spec_from_file_location(name, Path(__file__).with_name(name + '.py'))
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


storage = load('mac-storage-budget')


def contender(directory, size, floor, result, release):
    try:
        token = storage.budget('acquire', directory, size, floor, os.getpid())
    except RuntimeError:
        result.put(False)
    else:
        result.put(True)
        release.wait(10)
        storage.budget('release', None, 0, 0, token=token)


class StorageTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.directory = Path(self.temp.name)
        storage.STATE = self.directory / 'state'

    def test_two_jobs_cannot_claim_the_same_capacity(self):
        context = multiprocessing.get_context('fork')
        result, release = context.Queue(), context.Event()
        free = os.statvfs(self.directory)
        size = free.f_bavail * free.f_frsize * 2 // 3
        workers = [context.Process(target=contender, args=(self.directory, size, 0, result, release))
                   for _ in range(2)]
        for worker in workers:
            worker.start()
        try:
            self.assertEqual(sorted(result.get(timeout=10) for _ in workers), [False, True])
        finally:
            release.set()
            for worker in workers:
                worker.join(10)
                if worker.is_alive():
                    worker.kill()
                    worker.join()

    def test_readiness_respects_other_jobs_and_does_not_reserve(self):
        token = storage.budget('acquire', self.directory, 1, 100, os.getpid())
        path = storage.STATE / 'leases.json'
        original = path.read_text()
        storage.budget('peek', self.directory, 1, 0)
        self.assertEqual(path.read_text(), original)
        storage.budget('release', None, 0, 0, token=token)
        storage.budget('release', None, 0, 0, token=token)
        self.assertEqual(path.read_text(), '{}')

    def test_dead_owner_does_not_hold_capacity(self):
        worker = subprocess.Popen(['/bin/sleep', '30'])
        try:
            token = storage.budget('acquire', self.directory, 1, 0, worker.pid)
        finally:
            worker.terminate()
            worker.wait(timeout=5)
        new = storage.budget('acquire', self.directory, 1, 0, os.getpid())
        self.assertNotIn(token, (storage.STATE / 'leases.json').read_text())
        self.assertIn(new, (storage.STATE / 'leases.json').read_text())

    def test_corrupt_budget_state_stops_admission(self):
        storage.STATE.mkdir()
        (storage.STATE / 'leases.json').write_text('[]')
        with self.assertRaises(RuntimeError):
            storage.budget('peek', self.directory, 1, 0)

    def test_timed_out_probe_does_not_publish_partial_output(self):
        probe = Path(__file__).with_name('gc-read-probe.py')
        start = time.monotonic()
        hung = subprocess.run([sys.executable, str(probe), '.15', '/bin/sh', '-c',
                               'trap "" TERM; echo partial; sleep 30'],
                              capture_output=True, text=True, timeout=3)
        self.assertEqual(hung.returncode, 124)
        self.assertEqual(hung.stdout, '')
        self.assertLess(time.monotonic() - start, 3)
        good = subprocess.run([sys.executable, str(probe), '1', '/bin/echo', 'complete'],
                              capture_output=True, text=True, check=True, timeout=3)
        self.assertEqual(good.stdout, 'complete\n')


if __name__ == '__main__':
    unittest.main()
