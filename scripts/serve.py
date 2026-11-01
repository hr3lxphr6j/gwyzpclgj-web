#!/usr/bin/env python3
"""Tiny static server for web/ with the correct MIME type for .wasm.

Usage:
    python3 scripts/serve.py 8000              # serve web/ (default)
    python3 scripts/serve.py 8000 --root .     # serve the repository root

The second form is used by the browser tests so the page at /web/ can fetch
/tests/fixtures/... directly.
"""
import argparse
import functools
import http.server
import mimetypes
import os
import socketserver

mimetypes.add_type("application/wasm", ".wasm")
mimetypes.add_type("text/javascript", ".js")

REPO_ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
WEB_DIR = os.path.join(REPO_ROOT, "web")


class Handler(http.server.SimpleHTTPRequestHandler):
    extensions_map = {
        **http.server.SimpleHTTPRequestHandler.extensions_map,
        ".wasm": "application/wasm",
        ".js": "text/javascript",
        ".css": "text/css",
    }

    def __init__(self, *args, directory=None, **kwargs):
        super().__init__(*args, directory=directory or WEB_DIR, **kwargs)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument(
        "port",
        nargs="?",
        type=int,
        default=8000,
        help="TCP port on 127.0.0.1 (default: 8000)",
    )
    parser.add_argument(
        "--root",
        default=WEB_DIR,
        help="directory to serve (default: web/)",
    )
    args = parser.parse_args()

    root = os.path.abspath(args.root)
    if not os.path.isdir(root):
        parser.error(f"--root is not a directory: {args.root}")

    handler = functools.partial(Handler, directory=root)
    socketserver.TCPServer.allow_reuse_address = True
    with socketserver.TCPServer(("127.0.0.1", args.port), handler) as httpd:
        print(f"serving {root} at http://127.0.0.1:{args.port}/", flush=True)
        httpd.serve_forever()


if __name__ == "__main__":
    main()
