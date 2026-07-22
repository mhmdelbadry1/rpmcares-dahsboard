import type { Request, Response } from "express";
import { z } from "zod";
import { supabaseAdmin, supabaseAnon } from "../lib/supabase";
import { findProfileById, type ProfileRecord } from "../models/profile";
import { logAudit } from "../services/audit";

const SUSPENDED_MSG = "Your account has been suspended. Contact your administrator.";

function isBanError(err: unknown): boolean {
  const msg = ((err as any)?.message ?? "") as string;
  return msg.toLowerCase().includes("ban");
}

export async function refreshToken(req: Request, res: Response) {
  const { refreshToken: rt } = req.body;
  if (!rt || typeof rt !== "string") {
    return res.status(400).json({ error: "refreshToken is required." });
  }

  const { data, error } = await supabaseAnon.auth.refreshSession({ refresh_token: rt });
  if (error || !data.session || !data.user) {
    if (isBanError(error)) return res.status(403).json({ error: SUSPENDED_MSG });
    return res.status(401).json({ error: "Invalid or expired refresh token." });
  }

  const profile = await findProfileById(data.user.id);
  if (!profile) {
    return res.status(403).json({ error: "This account has no RPMCares profile yet." });
  }

  return res.json({
    token: data.session.access_token,
    refreshToken: data.session.refresh_token,
    expiresAt: data.session.expires_at,
    user: toPublicUser(profile),
  });
}

const loginSchema = z.object({
  email: z.string().email(),
  password: z.string().min(1),
});

function toPublicUser(profile: ProfileRecord) {
  return {
    id: profile.id,
    email: profile.email,
    role: profile.role,
    name: profile.name,
    clinicId: profile.clinic_id,
  };
}

export async function login(req: Request, res: Response) {
  const parsed = loginSchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({ error: "A valid email and password are required." });
  }

  const { email, password } = parsed.data;
  const { data, error } = await supabaseAnon.auth.signInWithPassword({ email, password });
  if (error || !data.session || !data.user) {
    if (isBanError(error)) return res.status(403).json({ error: SUSPENDED_MSG });
    return res.status(401).json({ error: "Invalid email or password." });
  }

  const profile = await findProfileById(data.user.id);
  if (!profile) {
    return res.status(403).json({ error: "This account has no RPMCares profile yet." });
  }

  logAudit(profile, "login", "Successful sign-in", profile.clinic_id)
    .catch((e) => console.warn("[audit] login failed:", e));

  return res.json({
    token: data.session.access_token,
    refreshToken: data.session.refresh_token,
    expiresAt: data.session.expires_at,
    user: toPublicUser(profile),
  });
}

export async function me(req: Request, res: Response) {
  const userId = req.auth?.sub;
  if (!userId) return res.status(401).json({ error: "Not authenticated." });

  const profile = await findProfileById(userId);
  if (!profile) return res.status(404).json({ error: "Profile not found." });

  return res.json({ user: toPublicUser(profile) });
}

export async function patchMe(req: Request, res: Response) {
  const userId = req.auth?.sub;
  if (!userId) return res.status(401).json({ error: "Not authenticated." });

  const { name, email, password } = req.body as {
    name?: string;
    email?: string;
    password?: string;
  };

  if (name === undefined && email === undefined && password === undefined) {
    return res.status(400).json({ error: "Provide at least one field to update." });
  }

  if (name !== undefined) {
    if (!name.trim()) return res.status(400).json({ error: "Name cannot be empty." });
    const { error } = await supabaseAdmin
      .from("profiles")
      .update({ name: name.trim() })
      .eq("id", userId);
    if (error) throw error;
  }

  if (email !== undefined || password !== undefined) {
    const authUpdate: { email?: string; password?: string } = {};

    if (email !== undefined) {
      if (!email.trim() || !email.includes("@")) {
        return res.status(400).json({ error: "A valid email address is required." });
      }
      authUpdate.email = email.trim().toLowerCase();
    }

    if (password !== undefined) {
      if (password.length < 8) {
        return res.status(400).json({ error: "Password must be at least 8 characters." });
      }
      authUpdate.password = password;
    }

    const { error: authError } = await supabaseAdmin.auth.admin.updateUserById(userId, authUpdate);
    if (authError) throw authError;

    if (email !== undefined) {
      const { error: profileError } = await supabaseAdmin
        .from("profiles")
        .update({ email: email.trim().toLowerCase() })
        .eq("id", userId);
      if (profileError) throw profileError;
    }
  }

  const profile = await findProfileById(userId);
  if (!profile) return res.status(404).json({ error: "Profile not found." });

  return res.json({ user: toPublicUser(profile) });
}
