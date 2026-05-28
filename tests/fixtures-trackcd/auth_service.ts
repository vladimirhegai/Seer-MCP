// Used by tests directory below — to verify test-edge synthesis works.
export class AuthService {
  login(username: string, password: string): boolean {
    if (!username || !password) return false;
    return validateCredentials(username, password);
  }

  logout(token: string): void {
    invalidateToken(token);
  }
}

export function validateCredentials(username: string, password: string): boolean {
  return username === password;
}

export function invalidateToken(_token: string): void {
  // no-op
}
