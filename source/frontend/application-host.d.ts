// Additive public @3mm/application-ui/v1 surface; no Core implementation imports.
declare module '@3mm/application-ui/v1' {
  import type { M21AuthorizedBridge, M21Target } from './services/m21TerminalTransport'
  export interface ApplicationSessionTarget extends M21Target {
    readonly bindingId: string
    readonly providerId: string
    readonly accessMode: 'read' | 'write'
    readonly controlActions: readonly string[]
    readonly options: Readonly<Record<string, unknown>>
  }
  export interface ApplicationSessions extends M21AuthorizedBridge {
    targets(): Promise<readonly ApplicationSessionTarget[]>
  }
  export function useApplicationHost(): { readonly sessions?: ApplicationSessions }
}
