/**
 * Framework-free signature pad controller (used by the handover/return flow).
 *
 * Works with iOS Safari, Android Chrome and mouse:
 * - Pointer Events (pointerdown/move/up/cancel), with a Touch Events fallback
 *   for browsers without PointerEvent (iOS < 13).
 * - Native non-passive touch listeners call preventDefault so the page never
 *   scrolls or zooms while signing (React registers touch listeners as passive,
 *   and iOS does not always honour `touch-action: none` on its own).
 * - The backing store is sized from getBoundingClientRect() × devicePixelRatio,
 *   re-measured on resize/rotation (a canvas measured while hidden is 0×0 and
 *   silently draws nothing), and every point is converted with the live rect,
 *   so strokes land under the finger whatever the CSS size.
 */

export type Point = { x: number; y: number };
type Rect = { left: number; top: number; width: number; height: number };

/** Client coordinates → canvas backing-store pixels (handles any CSS/backing size mismatch). */
export function toCanvasPoint(clientX: number, clientY: number, rect: Rect, canvasWidth: number, canvasHeight: number): Point {
  const sx = rect.width > 0 ? canvasWidth / rect.width : 1;
  const sy = rect.height > 0 ? canvasHeight / rect.height : 1;
  return { x: (clientX - rect.left) * sx, y: (clientY - rect.top) * sy };
}

/** Backing-store size for a CSS box at the given devicePixelRatio (0×0 while not laid out). */
export function backingSize(rect: Pick<Rect, "width" | "height">, dpr: number): { width: number; height: number } {
  const ratio = Number.isFinite(dpr) && dpr > 0 ? dpr : 1;
  return { width: Math.round(rect.width * ratio), height: Math.round(rect.height * ratio) };
}

type Ctx = Pick<CanvasRenderingContext2D, "save" | "restore" | "setTransform" | "fillRect" | "beginPath" | "moveTo" | "lineTo" | "stroke" | "arc" | "fill" | "drawImage"> & {
  fillStyle: CanvasRenderingContext2D["fillStyle"];
  strokeStyle: CanvasRenderingContext2D["strokeStyle"];
  lineWidth: number;
  lineCap: CanvasLineCap;
  lineJoin: CanvasLineJoin;
};

/** The subset of HTMLCanvasElement the controller needs (lets tests pass a fake). */
export type SignatureCanvas = {
  width: number;
  height: number;
  getBoundingClientRect(): Rect;
  getContext(type: "2d"): Ctx | null;
  addEventListener(type: string, fn: (e: never) => void, opts?: AddEventListenerOptions | boolean): void;
  removeEventListener(type: string, fn: (e: never) => void, opts?: EventListenerOptions | boolean): void;
  setPointerCapture?(id: number): void;
  releasePointerCapture?(id: number): void;
  toBlob(cb: (b: Blob | null) => void, type?: string): void;
};

export type SignatureEnv = {
  devicePixelRatio: () => number;
  pointerEvents: boolean;
  /** Creates a scratch canvas to keep the drawing across a resize (null = drop it). */
  scratch: () => { width: number; height: number; getContext(t: "2d"): Ctx | null } | null;
  observeResize: (target: SignatureCanvas, cb: () => void) => () => void;
};

const browserEnv = (): SignatureEnv => ({
  devicePixelRatio: () => globalThis.devicePixelRatio || 1,
  pointerEvents: typeof globalThis.PointerEvent === "function",
  scratch: () => (typeof document === "undefined" ? null : (document.createElement("canvas") as unknown as ReturnType<SignatureEnv["scratch"]>)),
  observeResize: (target, cb) => {
    const offs: (() => void)[] = [];
    if (typeof ResizeObserver === "function") {
      const ro = new ResizeObserver(() => cb());
      ro.observe(target as unknown as Element);
      offs.push(() => ro.disconnect());
    }
    if (typeof window !== "undefined") {
      window.addEventListener("resize", cb);
      window.addEventListener("orientationchange", cb);
      offs.push(() => window.removeEventListener("resize", cb), () => window.removeEventListener("orientationchange", cb));
    }
    return () => offs.forEach((f) => f());
  },
});

type PEvent = { pointerId: number; pointerType: string; button: number; isPrimary: boolean; clientX: number; clientY: number; cancelable?: boolean; preventDefault(): void; getCoalescedEvents?: () => { clientX: number; clientY: number }[] };
type TEvent = { cancelable?: boolean; preventDefault(): void; changedTouches: ArrayLike<{ identifier: number; clientX: number; clientY: number }> };

export type SignaturePadController = {
  resize(): void;
  clear(): void;
  isEmpty(): boolean;
  toBlob(type?: string): Promise<Blob | null>;
  destroy(): void;
};

export function createSignaturePad(canvas: SignatureCanvas, opts: { onChange?: (empty: boolean) => void; color?: string; lineWidth?: number; env?: Partial<SignatureEnv> } = {}): SignaturePadController {
  const env: SignatureEnv = { ...browserEnv(), ...opts.env };
  const color = opts.color ?? "#0f172a";
  const cssLineWidth = opts.lineWidth ?? 2.5;
  let empty = true;
  let active: number | null = null; // pointer id or touch identifier
  let last: Point | null = null;

  const ctx = () => canvas.getContext("2d");
  const setEmpty = (v: boolean) => {
    if (empty === v) return;
    empty = v;
    opts.onChange?.(v);
  };
  const paintBackground = (c: Ctx) => {
    c.save();
    c.setTransform(1, 0, 0, 1, 0, 0);
    c.fillStyle = "#fff";
    c.fillRect(0, 0, canvas.width, canvas.height);
    c.restore();
  };
  const style = (c: Ctx) => {
    // Everything is drawn in backing-store pixels with an identity transform.
    c.setTransform(1, 0, 0, 1, 0, 0);
    c.lineWidth = cssLineWidth * (canvas.width / Math.max(1, canvas.getBoundingClientRect().width || canvas.width));
    c.lineCap = "round";
    c.lineJoin = "round";
    c.strokeStyle = color;
    c.fillStyle = color;
  };

  const resize = () => {
    const rect = canvas.getBoundingClientRect();
    const size = backingSize(rect, env.devicePixelRatio());
    if (size.width === 0 || size.height === 0) return; // not laid out yet; the observer calls again
    if (size.width === canvas.width && size.height === canvas.height) return;
    const c = ctx();
    if (!c) return;
    // Keep an existing signature when the pad is resized (e.g. rotation).
    let keep: ReturnType<SignatureEnv["scratch"]> = null;
    if (!empty && canvas.width > 0 && canvas.height > 0) {
      keep = env.scratch();
      if (keep) {
        keep.width = canvas.width;
        keep.height = canvas.height;
        keep.getContext("2d")?.drawImage(canvas as unknown as CanvasImageSource, 0, 0);
      }
    }
    canvas.width = size.width;
    canvas.height = size.height;
    paintBackground(c);
    if (keep) c.drawImage(keep as unknown as CanvasImageSource, 0, 0, size.width, size.height);
    else if (!empty) setEmpty(true);
  };

  const at = (clientX: number, clientY: number) => toCanvasPoint(clientX, clientY, canvas.getBoundingClientRect(), canvas.width, canvas.height);

  const begin = (id: number, clientX: number, clientY: number) => {
    resize(); // first touch after a late layout
    const c = ctx();
    if (!c || canvas.width === 0) return false;
    active = id;
    last = at(clientX, clientY);
    style(c);
    // A tap leaves a dot.
    c.beginPath();
    c.arc(last.x, last.y, c.lineWidth / 2, 0, Math.PI * 2);
    c.fill();
    setEmpty(false);
    return true;
  };
  const extend = (points: { clientX: number; clientY: number }[]) => {
    const c = ctx();
    if (!c || !last) return;
    style(c);
    for (const p of points) {
      const next = at(p.clientX, p.clientY);
      c.beginPath();
      c.moveTo(last.x, last.y);
      c.lineTo(next.x, next.y);
      c.stroke();
      last = next;
    }
  };
  const end = () => {
    active = null;
    last = null;
  };

  // ---- Pointer Events
  const onPointerDown = (e: PEvent) => {
    if (active !== null) return;
    if (e.pointerType === "mouse" && e.button !== 0) return;
    if (e.cancelable !== false) e.preventDefault();
    if (!begin(e.pointerId, e.clientX, e.clientY)) return;
    try {
      canvas.setPointerCapture?.(e.pointerId);
    } catch {
      // iOS may refuse capture (InvalidStateError); drawing still works without it.
    }
  };
  const onPointerMove = (e: PEvent) => {
    if (active !== e.pointerId) return;
    if (e.cancelable !== false) e.preventDefault();
    const coalesced = e.getCoalescedEvents?.() ?? [];
    extend(coalesced.length ? coalesced : [e]);
  };
  const onPointerEnd = (e: PEvent) => {
    if (active !== e.pointerId) return;
    try {
      canvas.releasePointerCapture?.(e.pointerId);
    } catch {
      /* already released */
    }
    end();
  };

  // ---- Touch: always block scrolling/zooming on the pad; draw only without Pointer Events.
  const findTouch = (e: TEvent, id: number | null) => Array.from(e.changedTouches).find((t) => id === null || t.identifier === id);
  const onTouchStart = (e: TEvent) => {
    if (e.cancelable !== false) e.preventDefault();
    if (env.pointerEvents || active !== null) return;
    const t = findTouch(e, null);
    if (t) begin(t.identifier, t.clientX, t.clientY);
  };
  const onTouchMove = (e: TEvent) => {
    if (e.cancelable !== false) e.preventDefault();
    if (env.pointerEvents || active === null) return;
    const t = findTouch(e, active);
    if (t) extend([t]);
  };
  const onTouchEnd = (e: TEvent) => {
    if (env.pointerEvents || active === null) return;
    if (findTouch(e, active)) end();
  };

  const listeners: [string, (e: never) => void][] = [
    ["touchstart", onTouchStart],
    ["touchmove", onTouchMove],
    ["touchend", onTouchEnd],
    ["touchcancel", onTouchEnd],
  ];
  if (env.pointerEvents) {
    listeners.push(["pointerdown", onPointerDown], ["pointermove", onPointerMove], ["pointerup", onPointerEnd], ["pointercancel", onPointerEnd], ["lostpointercapture", onPointerEnd]);
  }
  const listenerOpts: AddEventListenerOptions = { passive: false };
  for (const [type, fn] of listeners) canvas.addEventListener(type, fn, listenerOpts);
  const stopObserving = env.observeResize(canvas, resize);
  resize();

  return {
    resize,
    clear() {
      const c = ctx();
      if (c) paintBackground(c);
      end();
      setEmpty(true);
    },
    isEmpty: () => empty,
    toBlob: (type = "image/png") => new Promise((resolve) => canvas.toBlob(resolve, type)),
    destroy() {
      for (const [type, fn] of listeners) canvas.removeEventListener(type, fn, listenerOpts);
      stopObserving();
    },
  };
}
