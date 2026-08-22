import type { NextFunction, Request, Response } from "express";
import { AppError } from "../http";
import { verifyAccessToken } from "./tokens";

export interface AuthContext {
  userId: string;
  role: string;
  tier: number;
}

declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace Express {
    interface Request {
      auth?: AuthContext;
    }
  }
}

// Require a valid Bearer access token. Populates req.auth. RLS is still the
// floor — this just establishes identity/role for the API + the app.user_id GUC.
export function requireAuth(req: Request, _res: Response, next: NextFunction) {
  const header = req.headers.authorization;
  if (!header?.startsWith("Bearer ")) {
    throw new AppError(401, "unauthorized", "Missing bearer token");
  }
  const claims = verifyAccessToken(header.slice(7));
  req.auth = { userId: claims.sub, role: claims.role, tier: claims.tier };
  next();
}

// Require an administrator (R2: any staff role). Use AFTER requireAuth.
export function requireAdmin(req: Request, _res: Response, next: NextFunction) {
  const role = req.auth?.role;
  if (!role || !["administrator", "coach", "content_manager", "pa"].includes(role)) {
    throw new AppError(403, "forbidden", "Administrator access required");
  }
  next();
}
