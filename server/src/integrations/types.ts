/**
 * Provider abstraction for external wash-data integrations.
 *
 * Nothing here knows how a real provider authenticates or what its endpoints look like:
 * that arrives with the provider's official API documentation. Until a provider has a
 * real adapter it answers WAITING_FOR_API — it never fabricates a connection or data.
 */

/** Decrypted credentials, handed to a provider on the server only. Never serialized, logged or audited. */
export type ProviderConfig = {
  baseUrl: string | null;
  apiKey: string | null;
  clientId: string | null;
  clientSecret: string | null;
};

/** Why a provider cannot work yet. */
export type WaitingReason = "NOT_CONFIGURED" | "ADAPTER_PENDING";

export type ProviderState = "READY" | "WAITING_FOR_API";

/** A wash operation as a provider reports it (shape agreed once the API documentation exists). */
export type ExternalWash = {
  externalId: string;
  plateRaw: string | null;
  payload: Record<string, unknown>;
};

export type TestResult =
  | { ok: true }
  | { ok: false; state: "WAITING_FOR_API"; reason: WaitingReason }
  | { ok: false; state: "FAILED"; reason: string };

export type SyncOutcome =
  | { state: "WAITING_FOR_API"; reason: WaitingReason }
  | { state: "FAILED"; reason: string }
  | { state: "COMPLETED"; washes: ExternalWash[] };

export type GetWashOutcome =
  | { state: "WAITING_FOR_API"; reason: WaitingReason }
  | { state: "FAILED"; reason: string }
  | { state: "FOUND"; wash: ExternalWash }
  | { state: "NOT_FOUND" };

export type SyncStatus = { state: ProviderState; reason?: WaitingReason };

export interface WashProvider {
  readonly key: string;
  testConnection(cfg: ProviderConfig): Promise<TestResult>;
  syncWashes(cfg: ProviderConfig, opts?: { since?: Date }): Promise<SyncOutcome>;
  getWash(cfg: ProviderConfig, externalId: string): Promise<GetWashOutcome>;
  getSyncStatus(cfg: ProviderConfig): Promise<SyncStatus>;
}
