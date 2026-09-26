import { describe, expect, it } from "vitest";
import { backingSize, createSignaturePad, toCanvasPoint, type SignatureCanvas, type SignatureEnv } from "./signature";

type Listener = { fn: (e: never) => void; opts?: AddEventListenerOptions | boolean };

/** Minimal canvas double: records listeners, drawing calls and pointer capture. */
function fakeCanvas(rect = { left: 10, top: 20, width: 300, height: 160 }, opts: { captureThrows?: boolean } = {}) {
  const calls: string[] = [];
  const listeners = new Map<string, Listener[]>();
  const ctx = {
    fillStyle: "" as unknown,
    strokeStyle: "" as unknown,
    lineWidth: 1,
    lineCap: "butt",
    lineJoin: "miter",
    save: () => calls.push("save"),
    restore: () => calls.push("restore"),
    setTransform: () => calls.push("setTransform"),
    fillRect: (...a: number[]) => calls.push(`fillRect:${a.join(",")}`),
    beginPath: () => calls.push("beginPath"),
    moveTo: (x: number, y: number) => calls.push(`moveTo:${x},${y}`),
    lineTo: (x: number, y: number) => calls.push(`lineTo:${x},${y}`),
    stroke: () => calls.push("stroke"),
    arc: (x: number, y: number) => calls.push(`arc:${x},${y}`),
    fill: () => calls.push("fill"),
    drawImage: () => calls.push("drawImage"),
  };
  const canvas = {
    width: 300,
    height: 150,
    rect,
    captured: [] as number[],
    getBoundingClientRect: () => canvas.rect,
    getContext: () => ctx,
    addEventListener: (type: string, fn: (e: never) => void, o?: AddEventListenerOptions | boolean) => listeners.set(type, [...(listeners.get(type) ?? []), { fn, opts: o }]),
    removeEventListener: (type: string, fn: (e: never) => void) => listeners.set(type, (listeners.get(type) ?? []).filter((l) => l.fn !== fn)),
    setPointerCapture: (id: number) => {
      if (opts.captureThrows) throw new Error("InvalidStateError");
      canvas.captured.push(id);
    },
    releasePointerCapture: () => undefined,
    toBlob: (cb: (b: Blob | null) => void, type?: string) => cb(new Blob(["png"], { type: type ?? "image/png" })),
  };
  const fire = (type: string, e: Record<string, unknown>) => {
    let prevented = false;
    const ev = { cancelable: true, preventDefault: () => (prevented = true), ...e };
    for (const l of listeners.get(type) ?? []) l.fn(ev as never);
    return prevented;
  };
  return { canvas: canvas as typeof canvas & SignatureCanvas, ctx, calls, listeners, fire };
}

const env = (over: Partial<SignatureEnv> = {}): Partial<SignatureEnv> => ({ devicePixelRatio: () => 3, pointerEvents: true, scratch: () => null, observeResize: () => () => undefined, ...over });
const pointer = (pointerId: number, clientX: number, clientY: number, pointerType = "touch") => ({ pointerId, pointerType, button: 0, isPrimary: true, clientX, clientY });

describe("signature pad geometry", () => {
  it("converts client coordinates with getBoundingClientRect and the backing-store scale", () => {
    expect(toCanvasPoint(110, 70, { left: 10, top: 20, width: 300, height: 160 }, 900, 480)).toEqual({ x: 300, y: 150 });
    expect(toCanvasPoint(10, 20, { left: 10, top: 20, width: 300, height: 160 }, 900, 480)).toEqual({ x: 0, y: 0 });
  });

  it("sizes the backing store from the CSS box × devicePixelRatio", () => {
    expect(backingSize({ width: 343.5, height: 160 }, 3)).toEqual({ width: 1031, height: 480 });
    expect(backingSize({ width: 300, height: 160 }, 0)).toEqual({ width: 300, height: 160 });
    expect(backingSize({ width: 0, height: 0 }, 2)).toEqual({ width: 0, height: 0 });
  });
});

describe("signature pad input", () => {
  it("registers non-passive touch listeners and blocks page scrolling while signing", () => {
    const f = fakeCanvas();
    createSignaturePad(f.canvas, { env: env() });
    for (const t of ["touchstart", "touchmove", "pointerdown", "pointermove", "pointerup", "pointercancel"]) {
      expect(f.listeners.get(t)?.[0]?.opts).toEqual({ passive: false });
    }
    expect(f.fire("touchstart", { changedTouches: [{ identifier: 1, clientX: 50, clientY: 50 }] })).toBe(true);
    expect(f.fire("touchmove", { changedTouches: [{ identifier: 1, clientX: 60, clientY: 60 }] })).toBe(true);
  });

  it("sizes the canvas for the device pixel ratio and draws a finger stroke under the finger", () => {
    const f = fakeCanvas();
    const changes: boolean[] = [];
    const pad = createSignaturePad(f.canvas, { env: env(), onChange: (e) => changes.push(e) });
    expect([f.canvas.width, f.canvas.height]).toEqual([900, 480]);
    expect(f.fire("pointerdown", pointer(7, 110, 70))).toBe(true);
    f.fire("pointermove", pointer(7, 120, 80));
    f.fire("pointerup", pointer(7, 120, 80));
    expect(f.calls).toContain("arc:300,150");
    expect(f.calls).toContain("moveTo:300,150");
    expect(f.calls).toContain("lineTo:330,180");
    expect(f.ctx.lineWidth).toBe(7.5); // 2.5 CSS px × 3
    expect(f.canvas.captured).toEqual([7]);
    expect(pad.isEmpty()).toBe(false);
    expect(changes).toEqual([false]);
  });

  it("keeps drawing when iOS refuses pointer capture", () => {
    const f = fakeCanvas(undefined, { captureThrows: true });
    const pad = createSignaturePad(f.canvas, { env: env() });
    expect(() => f.fire("pointerdown", pointer(1, 50, 50))).not.toThrow();
    f.fire("pointermove", pointer(1, 60, 60));
    expect(f.calls.some((c) => c.startsWith("lineTo:"))).toBe(true);
    expect(pad.isEmpty()).toBe(false);
  });

  it("stops the stroke on pointercancel and ignores other pointers / right clicks", () => {
    const f = fakeCanvas();
    createSignaturePad(f.canvas, { env: env() });
    f.fire("pointerdown", pointer(1, 50, 50));
    f.fire("pointermove", pointer(2, 90, 90)); // second finger: ignored
    f.fire("pointercancel", pointer(1, 50, 50));
    f.fire("pointermove", pointer(1, 70, 70)); // after cancel: ignored
    expect(f.calls.filter((c) => c.startsWith("lineTo:"))).toHaveLength(0);
    f.fire("pointerdown", { ...pointer(3, 50, 50, "mouse"), button: 2 });
    expect(f.calls.filter((c) => c.startsWith("arc:"))).toHaveLength(1);
  });

  it("draws with mouse input", () => {
    const f = fakeCanvas();
    createSignaturePad(f.canvas, { env: env({ devicePixelRatio: () => 1 }) });
    f.fire("pointerdown", pointer(1, 20, 30, "mouse"));
    f.fire("pointermove", pointer(1, 40, 50, "mouse"));
    expect(f.calls).toContain("lineTo:30,30");
  });

  it("falls back to touch events when Pointer Events are unavailable", () => {
    const f = fakeCanvas();
    const pad = createSignaturePad(f.canvas, { env: env({ pointerEvents: false }) });
    expect(f.listeners.has("pointerdown")).toBe(false);
    f.fire("touchstart", { changedTouches: [{ identifier: 4, clientX: 110, clientY: 70 }] });
    f.fire("touchmove", { changedTouches: [{ identifier: 4, clientX: 120, clientY: 80 }] });
    f.fire("touchend", { changedTouches: [{ identifier: 4, clientX: 120, clientY: 80 }] });
    expect(f.calls).toContain("lineTo:330,180");
    expect(pad.isEmpty()).toBe(false);
  });

  it("measures late: a pad that was 0×0 at mount sizes itself on the first touch", () => {
    const f = fakeCanvas({ left: 0, top: 0, width: 0, height: 0 });
    createSignaturePad(f.canvas, { env: env({ devicePixelRatio: () => 2 }) });
    expect([f.canvas.width, f.canvas.height]).toEqual([300, 150]); // untouched while hidden
    f.canvas.rect = { left: 0, top: 0, width: 200, height: 100 };
    f.fire("pointerdown", pointer(1, 50, 50));
    expect([f.canvas.width, f.canvas.height]).toEqual([400, 200]);
    expect(f.calls).toContain("arc:100,100");
  });

  it("clear resets to empty and save produces a PNG blob", async () => {
    const f = fakeCanvas();
    const changes: boolean[] = [];
    const pad = createSignaturePad(f.canvas, { env: env(), onChange: (e) => changes.push(e) });
    f.fire("pointerdown", pointer(1, 50, 50));
    pad.clear();
    expect(pad.isEmpty()).toBe(true);
    expect(changes).toEqual([false, true]);
    const blob = await pad.toBlob("image/png");
    expect(blob?.type).toBe("image/png");
  });

  it("destroy removes every listener", () => {
    const f = fakeCanvas();
    createSignaturePad(f.canvas, { env: env() }).destroy();
    expect([...f.listeners.values()].every((l) => l.length === 0)).toBe(true);
  });
});
