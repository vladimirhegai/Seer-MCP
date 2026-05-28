// Caller fixture: scope-aware resolution should bind `check()` here to
// remote_helper.ts's `check`, NOT local_helper.ts's `check`.
import { check } from './remote_helper';

export function callCheck(): string {
  return check();
}
