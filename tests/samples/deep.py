def settle(ledger, entries, policy):
    total = 0.0
    skipped = []
    for entry in entries:
        if entry["kind"] not in policy.allowed:
            skipped.append(entry["ref"])
            continue
        total += entry["amount"] * ledger.rate(entry["currency"])
    return round(total, 2), skipped
