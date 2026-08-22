import Stripe from "stripe";
import { env } from "./env";
import { AppError } from "./http";

// Lazy Stripe client. Constructed only when a Stripe-backed endpoint is hit, so
// the app boots without keys for local non-payment testing. The webhook needs a
// client too (constructEvent is an instance method) but does NOT call the API.
let client: Stripe | undefined;

export function stripe(): Stripe {
  if (!env.STRIPE_SECRET_KEY) {
    throw new AppError(503, "stripe_unconfigured", "Stripe is not configured");
  }
  client ??= new Stripe(env.STRIPE_SECRET_KEY);
  return client;
}
