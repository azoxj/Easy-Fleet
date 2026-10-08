import type { GetWashOutcome, ProviderConfig, SyncOutcome, SyncStatus, TestResult, WaitingReason, WashProvider } from "./types.js";

export const BRIGHT_WASHING = "BRIGHT_WASHING";

/**
 * الغسيل الساطع. The provider's API documentation has not been received, so no
 * authentication scheme, endpoint or payload is assumed: this adapter makes no network
 * call and returns no data. It reports WAITING_FOR_API — "not configured" when the
 * settings are incomplete, "adapter pending" when they are filled in but the real
 * adapter does not exist yet. The real HTTP client replaces `waiting()` once the
 * documentation arrives.
 */
export class BrightWashingProvider implements WashProvider {
  readonly key = BRIGHT_WASHING;

  private waiting(cfg: ProviderConfig): WaitingReason {
    return cfg.baseUrl && cfg.apiKey ? "ADAPTER_PENDING" : "NOT_CONFIGURED";
  }

  async testConnection(cfg: ProviderConfig): Promise<TestResult> {
    return { ok: false, state: "WAITING_FOR_API", reason: this.waiting(cfg) };
  }

  async syncWashes(cfg: ProviderConfig): Promise<SyncOutcome> {
    return { state: "WAITING_FOR_API", reason: this.waiting(cfg) };
  }

  async getWash(cfg: ProviderConfig): Promise<GetWashOutcome> {
    return { state: "WAITING_FOR_API", reason: this.waiting(cfg) };
  }

  async getSyncStatus(cfg: ProviderConfig): Promise<SyncStatus> {
    return { state: "WAITING_FOR_API", reason: this.waiting(cfg) };
  }
}

export const brightWashingProvider = new BrightWashingProvider();
