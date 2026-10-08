from dataclasses import dataclass


class Ledger:
    def __init__(self, rates):
        self.rates = rates

    def rate(self, currency):
        return self.rates[currency]


@dataclass
class Policy:
    allowed: tuple
