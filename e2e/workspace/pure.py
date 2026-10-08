from dataclasses import dataclass
from enum import Enum
from typing import Optional


class Tier(Enum):
    BASIC = "basic"
    GOLD = "gold"


@dataclass
class Customer:
    name: str
    tier: Tier
    age: int
    email: Optional[str] = None


def total(prices: list[float], tax: float = 0.2) -> float:
    subtotal = 0.0
    for price in prices:
        subtotal += price
    result = subtotal * (1 + tax)
    return round(result, 2)


def discount(customer: Customer, amount: float) -> float:
    if customer.tier is Tier.GOLD:
        rate = 0.2
    elif customer.age > 60:
        rate = 0.1
    else:
        rate = 0.0
    return helper_apply(amount, rate)


def helper_apply(amount, rate):
    reduced = amount * (1 - rate)
    return reduced


def untyped(items, flag, mystery):
    out = []
    for item in items:
        if flag:
            out.append(item * 2)
    label = "got %s" % mystery
    return out, label


def fails(n: int):
    values = [1, 2, 3]
    return values[n + 10]


def long_loop(n: int = 5000):
    acc = 0
    for i in range(n):
        acc += i
    return acc


def gen(count: int):
    for i in range(count):
        yield i * i


def prints(name: str):
    print("hello", name)
    import sys
    print("warn", file=sys.stderr)
    return len(name)


class Basket:
    def __init__(self, owner: str, limit: int = 10):
        self.owner = owner
        self.limit = limit
        self.items = []

    def add(self, item: str, qty: int = 1):
        if len(self.items) >= self.limit:
            raise ValueError("full")
        self.items.append((item, qty))
        return len(self.items)

    @staticmethod
    def static_sum(a: int, b: int):
        return a + b

    @classmethod
    def make(cls, owner: str):
        return cls(owner)

    @property
    def size(self):
        return len(self.items)
