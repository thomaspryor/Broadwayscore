#!/usr/bin/env python3
"""Bound a GC read probe even when macOS cannot promptly kill its I/O."""
import os
import signal
import subprocess
import sys
import tempfile


def main():
    deadline, *command = sys.argv[1:]
    if command == ['--stdin']:
        # The ownership check scans process arguments for paths in use.
        # Keep the supervisor's arguments path-free to avoid pinning its
        # own subject. The spawned probe still sees its original argv.
        command = [os.fsdecode(word) for word in sys.stdin.buffer.read().split(b'\0')[:-1]]
    if not command:
        return 125
    # Using a pipe would make the caller wait for EOF from a stuck child.
    # Mutating commands must never be passed here.
    with tempfile.TemporaryFile() as output:
        child = subprocess.Popen(command, stdin=subprocess.DEVNULL, stdout=output,
                                 stderr=subprocess.DEVNULL, start_new_session=True)
        try:
            status = child.wait(timeout=float(deadline))
        except subprocess.TimeoutExpired:
            try:
                os.killpg(child.pid, signal.SIGKILL)
            except ProcessLookupError:
                pass
            return 124
        if status == 0:
            output.seek(0)
            data = output.read(1024 * 1024 + 1)
            if len(data) > 1024 * 1024:
                return 125
            sys.stdout.buffer.write(data)
        return status if status >= 0 else 125


if __name__ == '__main__':
    sys.exit(main())
