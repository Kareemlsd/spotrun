from deep import settle
from deep_models import Ledger, Policy


def month_end():
    ledger = Ledger({"EUR": 1.0, "USD": 0.9})
    policy = Policy(allowed=("invoice", "refund"))
    entries = [
        {"ref": "A-1", "kind": "invoice", "amount": 100.0, "currency": "USD"},
        {"ref": "A-2", "kind": "transfer", "amount": 40.0, "currency": "EUR"},
    ]
    return settle(ledger, entries, policy)
