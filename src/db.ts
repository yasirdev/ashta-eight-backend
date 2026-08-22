import { PrismaClient } from "@prisma/client";
import { env } from "./env";

// Two clients mirror the two DB roles from the frozen contract (§2):
//
//  - prismaService: connects as `ashta_service` (BYPASSRLS). ONLY for the
//    legitimately cross-owner system flows the contract lists: registration,
//    login, token issue/verify, 2FA-secret access, Stripe webhook, anon
//    questionnaire capture, cron sweeps. All auth-secret tables (auth_identities,
//    refresh_tokens, verification_tokens, two_factor_secrets) are reachable ONLY
//    through this client.
//
//  - prismaApp: connects as `ashta_app` (RLS ENFORCED). Every authenticated
//    member/admin request goes through `asUser()`, which opens a transaction and
//    sets the session GUCs the RLS policies read. This is the floor; the API
//    layer adds authz on top.
export const prismaService = new PrismaClient({
  datasources: { db: { url: env.SERVICE_DATABASE_URL } },
});

export const prismaApp = new PrismaClient({
  datasources: { db: { url: env.APP_DATABASE_URL } },
});

type Tx = Parameters<Parameters<PrismaClient["$transaction"]>[0]>[0];

// Run `fn` inside a transaction with RLS session context set, so every policy in
// policies.sql evaluates against this user. `set_config(..., true)` is
// transaction-local (unlike `SET LOCAL ... = $1`, which can't be parameterised),
// so the GUC is scoped to — and cleared at the end of — this transaction. Values
// are bound as parameters → no SQL injection surface.
export function asUser<T>(
  userId: string,
  role: string,
  fn: (tx: Tx) => Promise<T>,
): Promise<T> {
  return prismaApp.$transaction(async (tx) => {
    await tx.$executeRaw`SELECT set_config('app.user_id', ${userId}, true), set_config('app.user_role', ${role}, true)`;
    return fn(tx);
  });
}
