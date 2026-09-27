import { afterEach, describe, expect, it, vi } from "vitest";
import { config } from "../src/config.js";
import { DEFAULT_TILES, hasCredential, resolveMapTiles, upstreamTileUrl } from "../src/lib/map-tiles.js";
import { userAndClient } from "./helpers.js";

describe("map tile provider resolution", () => {
  it("defaults to the CARTO Voyager basemap loaded directly, with attribution and CSP origins", () => {
    const t = resolveMapTiles({});
    expect(t).toMatchObject({ name: "CARTO Voyager", mode: "direct", browserUrl: DEFAULT_TILES.url, subdomains: ["a", "b", "c", "d"], maxZoom: 20 });
    expect(t.attribution).toContain("OpenStreetMap");
    expect(t.attribution).toContain("CARTO");
    expect(t.imgSrc).toEqual(["https://a.basemaps.cartocdn.com", "https://b.basemaps.cartocdn.com", "https://c.basemaps.cartocdn.com", "https://d.basemaps.cartocdn.com"]);
  });

  it("never serves the blocked public OSM tile server (falls back with a warning) and rejects invalid templates", () => {
    for (const url of ["https://tile.openstreetmap.org/{z}/{x}/{y}.png", "https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png"]) {
      const t = resolveMapTiles({ url, attribution: "x" });
      expect(t).toMatchObject({ name: "CARTO Voyager", mode: "direct", browserUrl: DEFAULT_TILES.url });
      expect(t.warning).toMatch(/tile\.openstreetmap\.org/);
      expect(JSON.stringify(t.imgSrc)).not.toContain("openstreetmap");
    }
    expect(() => resolveMapTiles({ url: "https://tiles.example.com/{z}/{x}.png" })).toThrow(/placeholders/);
    expect(() => resolveMapTiles({ url: "not a url {z}{x}{y}" })).toThrow(/valid URL/);
    expect(() => resolveMapTiles({ url: "http://tiles.example.com/{z}/{x}/{y}.png", production: true })).toThrow(/https/);
  });

  it("proxies templates that carry a key (never sent to the browser) and loads keyless ones directly", () => {
    for (const url of [
      "https://api.maptiler.com/maps/streets-v2/{z}/{x}/{y}.png?key=SECRET",
      "https://tiles.stadiamaps.com/tiles/alidade_smooth/{z}/{x}/{y}{r}.png?api_key=SECRET",
      "https://{s}.tile.thunderforest.com/transport/{z}/{x}/{y}.png?apikey=SECRET",
      "https://api.mapbox.com/styles/v1/me/style/tiles/{z}/{x}/{y}?access_token=SECRET",
    ]) {
      expect(hasCredential(url), url).toBe(true);
      const t = resolveMapTiles({ url });
      expect(t.mode, url).toBe("proxy");
      expect(t.browserUrl).toBe("/api/map/tiles/{z}/{x}/{y}");
      expect(t.imgSrc).toEqual([]);
      expect(JSON.stringify({ n: t.name, b: t.browserUrl, i: t.imgSrc })).not.toContain("SECRET");
    }
    const open = resolveMapTiles({ url: "https://tiles.example.com/{z}/{x}/{y}.png", attribution: "© Example" });
    expect(open).toMatchObject({ mode: "direct", name: "tiles.example.com", imgSrc: ["https://tiles.example.com"], attribution: "© Example", maxZoom: 19 });
    expect(resolveMapTiles({ url: "https://tiles.example.com/{z}/{x}/{y}.png" }).attribution).toContain("OpenStreetMap");
    expect(resolveMapTiles({ url: "https://tiles.example.com/{z}/{x}/{y}.png", proxy: "true" }).mode).toBe("proxy");
    expect(resolveMapTiles({ url: "https://tiles.example.com/{z}/{x}/{y}.png?key=pk", proxy: "false" }).mode).toBe("direct");
  });

  it("builds upstream tile URLs ({s} rotation, {r}, {-y})", () => {
    const t = resolveMapTiles({ url: "https://{s}.tiles.example.com/{z}/{x}/{y}{r}.png?key=K", subdomains: "abc" });
    expect(upstreamTileUrl(t, 3, 1, 2)).toBe("https://a.tiles.example.com/3/1/2.png?key=K");
    expect(upstreamTileUrl(t, 3, 2, 2)).toBe("https://b.tiles.example.com/3/2/2.png?key=K");
    expect(upstreamTileUrl({ upstream: "https://t.example.com/{z}/{x}/{-y}.png", subdomains: [] }, 2, 1, 0)).toBe("https://t.example.com/2/1/3.png");
    expect(resolveMapTiles({ url: "https://{s}.t.example.com/{z}/{x}/{y}.png", subdomains: "t1,t2" }).subdomains).toEqual(["t1", "t2"]);
  });
});

describe("map tiles over HTTP", () => {
  const original = config.mapTiles;
  afterEach(() => {
    config.mapTiles = original;
    vi.restoreAllMocks();
  });

  it("CSP allows only the configured tile origins (no OpenStreetMap tile server)", async () => {
    const { client } = await userAndClient(["VIEWER"]);
    const csp = (await client.get("/api/config/map")).headers["content-security-policy"] as string;
    const img = csp.split("; ").find((d) => d.startsWith("img-src"))!;
    expect(img).toContain("https://a.basemaps.cartocdn.com");
    expect(img).not.toContain("openstreetmap");
  });

  it("keyed provider: browser gets the same-origin proxy, the proxy fetches with User-Agent/Referer and the key stays server-side", async () => {
    config.mapTiles = resolveMapTiles({ url: "https://tiles.example.test/{z}/{x}/{y}.png?key=SECRET-KEY" });
    const png = Buffer.from([0x89, 0x50, 0x4e, 0x47]);
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response(png, { status: 200, headers: { "content-type": "image/png" } }));
    const { client } = await userAndClient(["VIEWER"]);
    const cfgRes = await client.get("/api/config/map");
    expect(cfgRes.body.data).toMatchObject({ mode: "proxy", tileUrl: "/api/map/tiles/{z}/{x}/{y}", subdomains: [] });
    expect(JSON.stringify(cfgRes.body) + cfgRes.headers["content-security-policy"]).not.toContain("SECRET-KEY");
    const tile = await client.get("/api/map/tiles/5/17/11");
    expect(tile.status).toBe(200);
    expect(tile.headers["content-type"]).toBe("image/png");
    const [url, init] = fetchSpy.mock.calls.at(-1)!;
    expect(String(url)).toBe("https://tiles.example.test/5/17/11.png?key=SECRET-KEY");
    const h = (init as RequestInit).headers as Record<string, string>;
    expect(h["User-Agent"]).toMatch(/^EasyFleet\//);
    expect(h.Referer).toMatch(/^https?:\/\//);
    expect((await client.get("/api/map/tiles/25/0/0")).status).toBe(400); // above maxZoom
    fetchSpy.mockResolvedValue(new Response("blocked", { status: 403, headers: { "content-type": "text/plain" } }));
    expect((await client.get("/api/map/tiles/5/18/11")).status).toBe(502); // upstream refusal → clear error, not a broken image
  });
});
