// Sample Java fixture for Strata smoke tests
import java.util.List;
import java.util.Optional;

public class OrderProcessor {

    private final InventoryService inventory;
    private final PaymentGateway payment;

    public OrderProcessor(InventoryService inventory, PaymentGateway payment) {
        this.inventory = inventory;
        this.payment = payment;
    }

    public OrderResult processOrder(Order order) {
        if (!validateOrder(order)) {
            return OrderResult.failure("Invalid order");
        }
        boolean reserved = inventory.reserve(order.getItems());
        if (!reserved) {
            return OrderResult.failure("Out of stock");
        }
        boolean charged = payment.charge(order.getTotal(), order.getCurrency());
        if (!charged) {
            inventory.release(order.getItems());
            return OrderResult.failure("Payment failed");
        }
        return OrderResult.success(order.getId());
    }

    private boolean validateOrder(Order order) {
        return order != null
            && order.getItems() != null
            && !order.getItems().isEmpty()
            && order.getTotal() > 0;
    }
}

interface InventoryService {
    boolean reserve(List<OrderItem> items);
    void release(List<OrderItem> items);
}

interface PaymentGateway {
    boolean charge(double amount, String currency);
    boolean refund(String transactionId);
}

class Order {
    private String id;
    private List<OrderItem> items;
    private double total;
    private String currency;

    public String getId()         { return id; }
    public List<OrderItem> getItems() { return items; }
    public double getTotal()      { return total; }
    public String getCurrency()   { return currency; }
}

class OrderItem {
    private String productId;
    private int quantity;

    public String getProductId() { return productId; }
    public int getQuantity()     { return quantity; }
}

class OrderResult {
    private final boolean success;
    private final String message;

    private OrderResult(boolean success, String message) {
        this.success = success;
        this.message = message;
    }

    public static OrderResult success(String orderId) {
        return new OrderResult(true, orderId);
    }

    public static OrderResult failure(String reason) {
        return new OrderResult(false, reason);
    }
}
