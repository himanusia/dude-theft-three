#!/usr/bin/env python3
"""Threaded static server for the game (ES modules + audio need http, not file://).

Listens on IPv4 (all interfaces) and on IPv6 loopback so `localhost` resolves either way.
"""
import http.server, socketserver, threading, os, sys, webbrowser, socket

os.chdir(os.path.dirname(os.path.abspath(__file__)))
PORT = int(sys.argv[1]) if len(sys.argv) > 1 else 8765


class Handler(http.server.SimpleHTTPRequestHandler):
    def log_message(self, *args):
        pass

    def end_headers(self):
        self.send_header("Cache-Control", "no-store")
        super().end_headers()


class V4(socketserver.ThreadingTCPServer):
    allow_reuse_address = True
    daemon_threads = True


class V6(socketserver.ThreadingTCPServer):
    address_family = socket.AF_INET6
    allow_reuse_address = True
    daemon_threads = True


if __name__ == "__main__":
    servers = [V4(("0.0.0.0", PORT), Handler)]
    try:
        servers.append(V6(("::1", PORT), Handler))
    except OSError:
        pass
    for srv in servers[1:]:
        threading.Thread(target=srv.serve_forever, daemon=True).start()

    url = f"http://localhost:{PORT}/"
    print(f"Dude Theft Auto (Three.js) -> {url}", flush=True)
    try:
        webbrowser.open(url)
    except Exception:
        pass
    try:
        servers[0].serve_forever()
    except KeyboardInterrupt:
        pass
