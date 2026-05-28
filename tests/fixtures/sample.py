"""Sample Python fixture for Strata smoke tests."""


class PaymentService:
    """Handles payment processing."""

    def __init__(self, gateway):
        self.gateway = gateway

    def process_payment(self, amount: float, currency: str) -> bool:
        if not validate_amount(amount):
            return False
        charge = self.charge_card(amount, currency)
        return charge is not None

    def charge_card(self, amount: float, currency: str):
        return self.gateway.charge(amount, currency)

    def refund(self, transaction_id: str) -> bool:
        return self.gateway.refund(transaction_id)


class OrderService:
    """Manages order lifecycle."""

    def __init__(self, payment_service: PaymentService):
        self.payment = payment_service

    def place_order(self, cart, user):
        total = calculate_total(cart)
        ok = self.payment.process_payment(total, "USD")
        if ok:
            notify_user(user, "Order placed!")
        return ok


def validate_amount(amount: float) -> bool:
    return isinstance(amount, (int, float)) and amount > 0


def calculate_total(cart) -> float:
    return sum(item.price * item.quantity for item in cart.items)


def notify_user(user, message: str) -> None:
    print(f"Notify {user.email}: {message}")
