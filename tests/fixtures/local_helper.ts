// Same-name function defined locally — must NOT be picked when caller.ts
// explicitly imports `check` from remote_helper.
export function check(): string {
  return 'local';
}
