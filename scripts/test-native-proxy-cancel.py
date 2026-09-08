"""Test the actual built native router with a stalled local HTTP peer; no model required.

Usage: python3 scripts/test-native-proxy-cancel.py /path/to/native-build/build
Uses the pinned CMake Unix Makefiles build's compiler/linker settings.
"""
import json
import pathlib
import shlex
import socket
import subprocess
import sys
import tempfile
import threading

build = pathlib.Path(sys.argv[1]).resolve() / '_deps/llama_cpp-build/tools/server'
source = pathlib.Path(__file__).resolve().parents[1] / 'tests/native-proxy-cancel.cpp'
flags = (build / 'CMakeFiles/llama-server-impl.dir/flags.make').read_text().splitlines()
args = []
for key in ('CXX_DEFINES = ', 'CXX_INCLUDES = ', 'CXX_FLAGS = '):
    args += shlex.split(next(line[len(key):] for line in flags if line.startswith(key)))

with tempfile.TemporaryDirectory(prefix='native-proxy-cancel-') as directory:
    work = pathlib.Path(directory)
    obj, binary = work / 'test.o', work / 'test'
    link = shlex.split((build / 'CMakeFiles/llama-server.dir/link.txt').read_text())
    subprocess.run([link[0], *args, '-c', str(source), '-o', str(obj)], check=True)
    link[link.index('CMakeFiles/llama-server.dir/main.cpp.o')] = str(obj)
    link[link.index('-o') + 1] = str(binary)
    subprocess.run(link, cwd=build, check=True)

    results = []
    for send_headers in (False, True):
        closed = threading.Event()
        with socket.socket() as listener:
            listener.bind(('127.0.0.1', 0))
            listener.listen()
            listener.settimeout(8)

            def backend():
                conn, _ = listener.accept()
                with conn:
                    conn.settimeout(8)
                    data = b''
                    while b'\r\n\r\n' not in data:
                        chunk = conn.recv(4096)
                        if not chunk:
                            return
                        data += chunk
                    if send_headers:
                        conn.sendall(b'HTTP/1.1 200 OK\r\nContent-Length: 100\r\n\r\n')
                    while conn.recv(4096):
                        pass
                    closed.set()

            thread = threading.Thread(target=backend)
            thread.start()
            with subprocess.Popen([str(binary), str(listener.getsockname()[1])],
                                  stdout=subprocess.PIPE, text=True) as process:
                assert process.stdout.readline().strip() == 'destroyed'
                early = closed.wait(1)
                alive = process.poll() is None
                process.wait(timeout=5)
            thread.join(timeout=9)
        results.append({'phase': 'pending_body' if send_headers else 'pending_headers',
                        'upstream_closed_within_1s': early, 'process_still_alive': alive})
    print(json.dumps(results, indent=2))
    assert all(row['upstream_closed_within_1s'] and row['process_still_alive'] for row in results)
