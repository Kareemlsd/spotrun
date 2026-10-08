import numpy as np


def normalise(x: np.ndarray, eps: float = 1e-9):
    mean = x.mean()
    centred = x - mean
    scale = np.sqrt((centred**2).sum()) + eps
    return centred / scale
