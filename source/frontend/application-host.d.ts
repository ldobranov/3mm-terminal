// Additive public @3mm/application-ui/v1 surface; no Core implementation imports.
declare module '@3mm/application-ui/v1' {
  export type ApplicationSessionTarget = import('./services/m21TerminalTransport').M21Target & {
    readonly bindingId: string
    readonly providerId: string
    readonly accessMode: 'read' | 'write'
    readonly controlActions: readonly string[]
    readonly options: Readonly<Record<string, unknown>>
  }
  export type ApplicationSessions = import('./services/m21TerminalTransport').M21AuthorizedBridge & {
    targets(): Promise<readonly ApplicationSessionTarget[]>
  }
  export function useApplicationHost(): { readonly sessions?: ApplicationSessions }
}
