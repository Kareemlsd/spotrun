import socket

_sock = socket.socket()
_sock.settimeout(2)
_sock.connect(("192.0.2.1", 9))


def f():
    return 1
