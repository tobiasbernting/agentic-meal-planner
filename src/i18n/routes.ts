import type { FeaturePlugin } from "../app.js";
import { LANG_COOKIE, isLang } from "./index.js";

const ONE_YEAR_SECONDS = 31536000;

/** A same-origin relative path ("/x"), else undefined (blocks "//host", "/\host", absolute URLs). */
function safePath(value: unknown): string | undefined {
  if (typeof value !== "string" || !value.startsWith("/")) return undefined;
  if (value.startsWith("//") || value.startsWith("/\\") || /[\r\n]/.test(value)) return undefined;
  return value;
}

/** Path + query of a Referer pointing at this host. */
function refererPath(referer: string | undefined, host: string | undefined): string | undefined {
  if (!referer || !host) return undefined;
  try {
    const url = new URL(referer);
    return url.host === host ? safePath(url.pathname + url.search) : undefined;
  } catch {
    return undefined;
  }
}

export const langRoutes: FeaturePlugin = async (app) => {
  app.post<{ Body: { lang?: string; next?: string } | undefined }>("/lang", async (req, reply) => {
    const lang = req.body?.lang;
    if (!isLang(lang)) return reply.code(400).send("Unsupported language");
    const next = safePath(req.body?.next) ?? refererPath(req.headers.referer, req.headers.host) ?? "/";
    reply.header("set-cookie", `${LANG_COOKIE}=${lang}; Path=/; Max-Age=${ONE_YEAR_SECONDS}; SameSite=Lax`);
    return reply.redirect(next, 303);
  });
};
