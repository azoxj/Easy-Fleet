import { randomBytes } from "node:crypto";
import { and, eq, isNull } from "drizzle-orm";
import { Router } from "express";
import QRCode from "qrcode";
import { z } from "zod";
import { getVehicleInScope, vehicleScope } from "../../auth/access.js";
import { config } from "../../config.js";
import { db } from "../../db/client.js";
import { vehicles } from "../../db/schema/index.js";
import { ctx } from "../../http/context.js";
import { notFound } from "../../http/errors.js";
import { requirePermission } from "../../http/middleware.js";
import { idParam } from "../../http/validate.js";

export const qrRouter = Router();

/**
 * Each vehicle gets a random QR token (never its database id). Scanning opens
 * /q/<token> in the web app; resolving it requires a session and vehicle scope,
 * so a leaked sticker reveals nothing to outsiders.
 */
async function ensureToken(vehicleId: string, current: string | null) {
  if (current) return current;
  const token = randomBytes(18).toString("base64url");
  const [u] = await db.update(vehicles).set({ qrToken: token }).where(and(eq(vehicles.id, vehicleId), isNull(vehicles.qrToken))).returning({ qrToken: vehicles.qrToken });
  if (u?.qrToken) return u.qrToken;
  const [v] = await db.select({ qrToken: vehicles.qrToken }).from(vehicles).where(eq(vehicles.id, vehicleId));
  return v!.qrToken!;
}

const Format = z.object({ format: z.enum(["svg", "png"]).default("svg") });

qrRouter.get("/vehicles/:id/qr", requirePermission("vehicles.read"), async (req, res) => {
  const { access } = ctx(req);
  const { id } = idParam.parse(req.params);
  const { format } = Format.parse(req.query);
  const v = await getVehicleInScope(db, access, id, "vehicles.read");
  const token = await ensureToken(v.id, v.qrToken);
  const url = `${config.publicAppUrl}/q/${token}`;
  res.setHeader("Cache-Control", "private, no-store");
  if (format === "png") {
    const buf = await QRCode.toBuffer(url, { type: "png", errorCorrectionLevel: "M", margin: 2, width: 512 });
    res.setHeader("Content-Type", "image/png");
    res.setHeader("Content-Disposition", `inline; filename="qr-${encodeURIComponent(v.plateNumber)}.png"`);
    res.end(buf);
    return;
  }
  const svg = await QRCode.toString(url, { type: "svg", errorCorrectionLevel: "M", margin: 2 });
  res.setHeader("Content-Type", "image/svg+xml; charset=utf-8");
  res.setHeader("Content-Security-Policy", "default-src 'none'; style-src 'unsafe-inline'");
  res.end(svg);
});

qrRouter.get("/vehicles/:id/qr-info", requirePermission("vehicles.read"), async (req, res) => {
  const { access } = ctx(req);
  const { id } = idParam.parse(req.params);
  const v = await getVehicleInScope(db, access, id, "vehicles.read");
  const token = await ensureToken(v.id, v.qrToken);
  res.json({ data: { url: `${config.publicAppUrl}/q/${token}`, plateNumber: v.plateNumber } });
});

const TokenParam = z.object({ token: z.string().regex(/^[A-Za-z0-9_-]{16,64}$/) });

qrRouter.get("/qr/:token", requirePermission("vehicles.read"), async (req, res) => {
  const { access } = ctx(req);
  const p = TokenParam.safeParse(req.params);
  if (!p.success) throw notFound("المركبة غير موجودة");
  const [v] = await db
    .select({ id: vehicles.id, plateNumber: vehicles.plateNumber })
    .from(vehicles)
    .where(and(eq(vehicles.qrToken, p.data.token), vehicleScope(access, "vehicles.read")))
    .limit(1);
  if (!v) throw notFound("المركبة غير موجودة أو خارج صلاحياتك");
  res.json({ data: v });
});
