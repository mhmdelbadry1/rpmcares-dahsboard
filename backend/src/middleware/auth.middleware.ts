import type { NextFunction, Request, Response } from "express";
import { supabaseAdmin } from "../lib/supabase";
import { findProfileById, type Role } from "../models/profile";
import { env } from "../env";

const SUSPENDED_MSG = "Your account has been suspended. Contact your administrator.";

export async function requireAuth(req: Request, res: Response, next: NextFunction) {
  const header = req.headers.authorization;
  const token = header?.startsWith("Bearer ") ? header.slice(7) : null;
  if (!token) return res.status(401).json({ error: "Missing bearer token." });

  const { data, error } = await supabaseAdmin.auth.getUser(token);

  if (error) {
    const errMsg = ((error as any)?.message ?? "") as string;
    if (errMsg.toLowerCase().includes("ban")) {
      return res.status(403).json({ error: SUSPENDED_MSG });
    }
    return res.status(401).json({ error: "Invalid or expired token." });
  }

  if (!data.user) return res.status(401).json({ error: "Invalid or expired token." });

  // Defense-in-depth: GoTrue may return the user even when banned; check explicitly.
  const bannedUntil = (data.user as any).banned_until as string | null | undefined;
  if (bannedUntil && new Date(bannedUntil) > new Date()) {
    return res.status(403).json({ error: SUSPENDED_MSG });
  }

  req.auth = { sub: data.user.id, email: data.user.email ?? "" };
  next();
}

/** Accepts a service-to-service call using INGEST_SECRET as a bearer token. */
export function requireServiceKey(req: Request, res: Response, next: NextFunction) {
  const header = req.headers.authorization;
  if (header === `Bearer ${env.INGEST_SECRET}`) return next();
  return res.status(401).json({ error: "Invalid service key." });
}

/** Must run after requireAuth. Loads the caller's profile and checks their role. */
export function requireRole(...roles: Role[]) {
  return async (req: Request, res: Response, next: NextFunction) => {
    if (!req.auth) return res.status(401).json({ error: "Not authenticated." });

    const profile = await findProfileById(req.auth.sub);
    if (!profile) return res.status(403).json({ error: "No profile found for this account." });
    if (!roles.includes(profile.role)) return res.status(403).json({ error: "Not authorized." });

    req.profile = profile;
    next();
  };
}
