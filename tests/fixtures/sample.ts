// Sample TypeScript fixture for Strata smoke tests

interface User {
  id: string;
  email: string;
  name: string;
}

interface Cart {
  items: Array<{ productId: string; quantity: number; price: number }>;
}

class AuthService {
  private tokenStore: Map<string, string>;

  constructor() {
    this.tokenStore = new Map();
  }

  authenticate(email: string, password: string): string | null {
    const hash = hashPassword(password);
    const userId = lookupUser(email, hash);
    if (!userId) return null;
    const token = generateToken(userId);
    this.tokenStore.set(token, userId);
    return token;
  }

  validateToken(token: string): string | null {
    return this.tokenStore.get(token) ?? null;
  }

  logout(token: string): void {
    this.tokenStore.delete(token);
  }
}

class CartService {
  addItem(cart: Cart, productId: string, qty: number): Cart {
    const price = fetchPrice(productId);
    const existing = cart.items.find(i => i.productId === productId);
    if (existing) {
      existing.quantity += qty;
    } else {
      cart.items.push({ productId, quantity: qty, price });
    }
    return cart;
  }

  totalPrice(cart: Cart): number {
    return cart.items.reduce((sum, i) => sum + i.price * i.quantity, 0);
  }
}

function hashPassword(password: string): string {
  return Buffer.from(password).toString('base64');
}

function lookupUser(email: string, hash: string): string | null {
  // stub — would query DB
  return `user-${email}`;
}

function generateToken(userId: string): string {
  return `tok-${userId}-${Date.now()}`;
}

function fetchPrice(productId: string): number {
  return 9.99; // stub
}

// Exercises `new X()` extraction — must be tracked as a call edge from
// createAuthService → AuthService (constructor).
function createAuthService(): AuthService {
  return new AuthService();
}
