// Test file — `tests/` directory triggers role='test' classification.
// Calls into AuthService.login + validateCredentials should produce 'tests' edges.
import { AuthService, validateCredentials } from '../auth_service';

function testAuthServiceLogin() {
  const svc = new AuthService();
  const ok = svc.login('alice', 'alice');
  return ok;
}

function testValidateCredentials() {
  return validateCredentials('foo', 'foo');
}
