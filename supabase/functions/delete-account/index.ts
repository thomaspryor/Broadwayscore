/**
 * delete-account edge function entry point. The handler lives in handler.mjs
 * (plain ESM, unit-tested under Node); see it for the security model and the
 * Sign in with Apple revocation (BRO-6290).
 */
import { handleDeleteAccount } from './handler.mjs';

Deno.serve((req) => handleDeleteAccount(req, { env: (name) => Deno.env.get(name) }));
