import gzip
import json
import os
import pathlib
import shutil
import tempfile
import zipfile

import numpy as np
import pandas as pd


def many_writers(tag: str = "w"):
    done = []
    pathlib.Path("out_path.txt").write_text("hello")
    done.append(pathlib.Path("out_path.txt").read_text())
    with open("out_json.json", "w", encoding="utf-8") as handle:
        json.dump({"a": 1}, handle)
    np.save("out_array.npy", np.arange(3))
    np.savetxt("out_array.txt", np.arange(3))
    pd.DataFrame({"a": [1, 2]}).to_csv("out_frame.csv", index=False)
    with gzip.open("out.gz", "wt") as handle:
        handle.write("zipped")
    with zipfile.ZipFile("out.zip", "w") as archive:
        archive.writestr("inner.txt", "data")
    shutil.copy("writers.py", "writers_copy.py")
    os.rename("writers.py", "writers_moved.py")
    pathlib.Path("new_dir").mkdir()
    pathlib.Path("writers.py").unlink()
    with open("out_append.log", "a") as handle:
        handle.write("line\n")
    done.append(pd.read_csv("out_frame.csv").shape)
    return done


def low_level_write():
    fd = os.open("out_lowlevel.bin", os.O_WRONLY | os.O_CREAT)
    os.write(fd, b"x")
    os.close(fd)


def temp_files_are_real():
    with tempfile.TemporaryDirectory() as folder:
        target = os.path.join(folder, "scratch.txt")
        with open(target, "w") as handle:
            handle.write("real")
        with open(target) as handle:
            content = handle.read()
        os.remove(target)
        return content, os.path.exists(target)
