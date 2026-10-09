"""Order pricing for the web shop."""

from dataclasses import dataclass

import requests

API = "https://api.shop.example"


@dataclass
class Customer:
    name: str
    tier: str  # "basic" or "gold"


def discount_rate(customer: Customer, subtotal: float) -> float:
    if customer.tier == "gold":
        return 0.15
    if subtotal >= 100:
        return 0.05
    return 0.0


def order_total(customer: Customer, order_id: int) -> float:
    response = requests.get(f"{API}/orders/{order_id}", timeout=5)
    if response.status_code != 200:
        raise LookupError(f"order {order_id} not found")
    subtotal = 0.0
    for line in response.json()["lines"]:
        subtotal += line["price"] * line["quantity"]
    rate = discount_rate(customer, subtotal)
    return round(subtotal * (1 - rate), 2)
