#!/usr/bin/env python3
"""Shared admission budget for BroadwayScorecard processes on this Mac.

Reservations cover expected growth for the entire job. Live free space also
reflects already-written bytes, so admission errs on the side of waiting.
An expired reservation never credits bytes back to measured free space.
"""
import argparse
import fcntl
import json
import os
from pathlib import Path
import secrets
import subprocess
import sys
import tempfile
import time

GIB = 1024 ** 3
STATE = Path.home() / '.bsc-mac-runner-storage' / 'budget-v1'
PS_ENV = dict(os.environ, TZ='UTC', LC_ALL='C')


def identity(pid):
    result = subprocess.run(['/bin/ps', '-p', str(pid), '-o', 'lstart='],
                            capture_output=True, text=True, timeout=1, env=PS_ENV)
    return result.stdout.strip() if result.returncode == 0 else ''


def alive(owner):
    try:
        os.kill(owner['pid'], 0)
    except ProcessLookupError:
        return False
    except PermissionError:
        return True
    start = identity(owner['pid'])
    return not start or start == owner['start']


def worker_pid():
    pid = os.getppid()
    while pid > 1:
        result = subprocess.run(['/bin/ps', '-p', str(pid), '-o', 'ppid=,comm='],
                                capture_output=True, text=True, timeout=1, env=PS_ENV)
        parts = result.stdout.strip().split(None, 1)
        if len(parts) != 2:
            break
        if Path(parts[1]).name == 'Runner.Worker':
            return pid
        pid = int(parts[0])
    raise RuntimeError('Cannot identify the iOS runner worker')


def load(path):
    try:
        entries = json.loads(path.read_text())
    except FileNotFoundError:
        return {}
    if not isinstance(entries, dict):
        raise RuntimeError('Invalid local storage reservation state')
    for entry in entries.values():
        for key in ('device', 'pid', 'bytes', 'floor'):
            if type(entry[key]) is not int or entry[key] < (1 if key == 'pid' else 0):
                raise RuntimeError('Invalid local storage reservation state')
        if not isinstance(entry['start'], str) or not entry['start']:
            raise RuntimeError('Invalid local storage reservation owner')
    return entries


def save(path, entries):
    fd, name = tempfile.mkstemp(dir=path.parent)
    try:
        with os.fdopen(fd, 'w') as file:
            json.dump(entries, file)
        os.replace(name, path)
    finally:
        if os.path.exists(name):
            os.unlink(name)


def budget(action, path, size, floor, pid=None, token=None):
    device = None
    if action != 'release':
        device = os.stat(path).st_dev
    owner = None
    if action == 'acquire':
        start = identity(pid)
        if not start:
            raise RuntimeError('Cannot identify reservation owner')
        owner = dict(device=device, pid=pid, start=start, bytes=size, floor=floor)
    STATE.mkdir(mode=0o700, parents=True, exist_ok=True)
    with (STATE / 'lock').open('a') as lock:
        deadline = time.monotonic() + 2
        while True:
            try:
                fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
                break
            except BlockingIOError:
                if time.monotonic() >= deadline:
                    raise RuntimeError('Local storage budget is busy, retry shortly')
                time.sleep(0.05)
        file = STATE / 'leases.json'
        entries = load(file)
        if action == 'release':
            if token in entries:
                del entries[token]
                save(file, entries)
            return
        entries = {k: v for k, v in entries.items() if alive(v)}
        if token in entries:
            if entries[token] != owner:
                raise RuntimeError('Local storage reservation already has an owner')
            return token
        active = [entry for entry in entries.values() if entry['device'] == device]
        floor = max([floor, *(entry['floor'] for entry in active)])
        reserved = sum(entry['bytes'] for entry in active)
        fs = os.statvfs(path)
        free = fs.f_bavail * fs.f_frsize
        needed = size + floor + reserved
        if free < needed:
            raise RuntimeError(f'Storage deferred: {free/GIB:.1f} GiB free, {needed/GIB:.1f} GiB needed '
                               f'({size/GIB:g} this job + {reserved/GIB:g} other jobs + {floor/GIB:g} reserve)')
        if action == 'acquire':
            token = token or secrets.token_hex(16)
            entries[token] = owner
            save(file, entries)
            return token


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('action', choices=('acquire', 'peek', 'release'))
    parser.add_argument('--path', type=Path)
    parser.add_argument('--size-gib', type=float, default=0)
    parser.add_argument('--floor-gib', type=float, default=0)
    parser.add_argument('--pid', type=int)
    parser.add_argument('--worker', action='store_true')
    parser.add_argument('--token')
    args = parser.parse_args()
    if args.action == 'release' and not args.token:
        parser.error('release needs a token')
    if args.action != 'release' and not args.path:
        parser.error('path is required')
    if min(args.size_gib, args.floor_gib) < 0:
        parser.error('allowances must be nonnegative')
    pid = worker_pid() if args.worker else args.pid
    if args.action == 'acquire' and (pid is None or pid < 2):
        parser.error('acquire needs an owner PID')
    token = budget(args.action, args.path, int(args.size_gib * GIB),
                   int(args.floor_gib * GIB), pid, args.token)
    if token:
        print(token)


if __name__ == '__main__':
    try:
        main()
    except (OSError, ValueError, RuntimeError, KeyError, subprocess.SubprocessError) as exc:
        print(exc, file=sys.stderr)
        sys.exit(1)
