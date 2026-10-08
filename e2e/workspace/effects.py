import json
import os
import socket
import subprocess
import time

import requests


def fetch_prices(base_url: str, min_price: float = 5.0):
    response = requests.get(base_url + "/items", timeout=3)
    if response.status_code != 200:
        return []
    data = response.json()
    cheap = []
    for item in data["items"]:
        if item["price"] >= min_price:
            cheap.append(item["name"])
    return cheap


def parse_body(url: str):
    response = requests.post(url, json={"a": 1})
    text = response.text
    payload = json.loads(text)
    return payload["count"] + 1


def parse_inline(url: str):
    return json.loads(requests.get(url).text)["count"] * 2


def write_report(name: str, rows: list[int]):
    path = os.path.join("reports_out", name + ".csv")
    os.makedirs("reports_out", exist_ok=True)
    with open(path, "w") as handle:
        for row in rows:
            handle.write("%d\n" % row)
    with open(path) as handle:
        back = handle.read()
    os.remove(path)
    return back


def read_config():
    with open("does_not_exist.cfg") as handle:
        content = handle.read()
    return content.upper()


def shell(cmd: str):
    time.sleep(30)
    completed = subprocess.run(cmd, shell=True, capture_output=True)
    if completed.returncode == 0:
        return completed.stdout
    return None


def raw_socket(host: str):
    sock = socket.socket()
    sock.connect((host, 9))
    return sock.recv(10)


def swallow(host: str):
    try:
        sock = socket.socket()
        sock.connect((host, 9))
    except Exception:
        return "swallowed"
    return "connected"


def via_library(key: str):
    import fakelib

    client = fakelib.Client("10.255.255.1")
    record = client.fetch(key)
    return record["value"] + 1


class Service:
    def __init__(self, host: str):
        self.conn = socket.create_connection((host, 5432), timeout=1)
        self.conn.sendall(b"hello")
        self.ready = True

    def lookup(self, key: str):
        self.conn.sendall(key.encode())
        answer = self.conn.recv(100)
        return answer


class Heavy:
    def __init__(self, path):
        raise RuntimeError("cannot construct outside production")

    def compute(self, x: int):
        return self.factor * x + self.offset
