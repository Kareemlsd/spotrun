"""Pretend third-party client, outside the workspace, that opens a socket."""
import socket


class Client:
    def __init__(self, host):
        self.host = host

    def fetch(self, key):
        sock = socket.socket()
        sock.settimeout(0.5)
        sock.connect((self.host, 9))
        return {"value": 1}
