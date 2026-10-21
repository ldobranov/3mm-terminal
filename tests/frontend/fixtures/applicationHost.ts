// Test-only resolution of the public host supplied by Core at runtime.
// Component tests must explicitly provide a mock; there is no fallback host.
export function useApplicationHost(): never {
  throw new Error('The test must provide its public application host')
}
