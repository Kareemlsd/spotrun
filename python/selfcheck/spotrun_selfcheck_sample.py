"""Small functions the Spot Run self-check runs on your machine."""

import socket


def discounted(price: float, rate: float = 0.1) -> float:
    reduced = price * (1 - rate)
    return round(reduced, 2)


def calls_out(host: str = "192.0.2.1"):
    connection = socket.socket()
    connection.settimeout(2)
    connection.connect((host, 9))
    return "connected"
