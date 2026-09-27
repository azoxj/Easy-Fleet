import { describe, expect, it } from "vitest";
import { createTileHealth, ERROR_TILE, tileLayerOptions, type MapConfig } from "./mapTiles";

const base: MapConfig = { provider: "CARTO Voyager", mode: "direct", tileUrl: "https://{s}.basemaps.cartocdn.com/rastertiles/voyager/{z}/{x}/{y}{r}.png", subdomains: ["a", "b", "c", "d"], attribution: "© OpenStreetMap contributors © CARTO", maxZoom: 20, center: { lat: 24.7, lng: 46.6 }, zoom: 6 };

describe("tile layer options", () => {
  it("passes provider subdomains, attribution and a neutral error tile", () => {
    const o = tileLayerOptions(base);
    expect(o).toMatchObject({ maxZoom: 20, attribution: base.attribution, subdomains: ["a", "b", "c", "d"], errorTileUrl: ERROR_TILE });
    expect(ERROR_TILE.startsWith("data:image/svg+xml")).toBe(true);
  });

  it("sends only the site origin to a direct provider; the proxy stays same-origin", () => {
    expect(tileLayerOptions(base).referrerPolicy).toBe("strict-origin-when-cross-origin");
    const proxy = tileLayerOptions({ ...base, mode: "proxy", tileUrl: "/api/map/tiles/{z}/{x}/{y}", subdomains: [] });
    expect(proxy.referrerPolicy).toBe("same-origin");
    expect("subdomains" in proxy).toBe(false);
  });
});

describe("tile health", () => {
  it("starts loading, becomes ok on loads", () => {
    const h = createTileHealth();
    expect(h.status()).toBe("loading");
    expect(h.load()).toBe("ok");
  });

  it("reports failure when most recent tiles fail, and recovers when tiles load again", () => {
    const h = createTileHealth({ window: 8, minErrors: 4 });
    h.error();
    h.error();
    expect(h.error()).toBe("ok"); // 3 errors: below the threshold
    expect(h.error()).toBe("failed");
    for (let i = 0; i < 4; i++) h.load();
    expect(h.status()).toBe("ok"); // 4 errors / 8 is not a majority
    for (let i = 0; i < 4; i++) h.load();
    expect(h.status()).toBe("ok");
  });

  it("a few missing tiles among many good ones are not an outage", () => {
    const h = createTileHealth();
    for (let i = 0; i < 12; i++) h.load();
    for (let i = 0; i < 4; i++) h.error();
    expect(h.status()).toBe("ok");
  });

  it("reset clears the history (retry)", () => {
    const h = createTileHealth({ minErrors: 2 });
    h.error();
    h.error();
    expect(h.status()).toBe("failed");
    expect(h.reset()).toBe("loading");
  });
});
