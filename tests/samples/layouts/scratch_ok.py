import tempfile


def f():
    with tempfile.NamedTemporaryFile("w+") as handle:
        handle.write("ok")
        handle.seek(0)
        return handle.read()
