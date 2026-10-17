/** HTMX request helpers shared by the routes that answer both HTMX and plain form posts. */
import type { FastifyReply, FastifyRequest } from "fastify";

/** Whether the request came from HTMX (its `HX-Request` header). */
export function isHtmx(req: FastifyRequest): boolean {
  return req.headers["hx-request"] === "true";
}

/** Sends the browser to `url`: HX-Redirect for an HTMX request, a 303 for a plain form. */
export function navigate(req: FastifyRequest, reply: FastifyReply, url: string): FastifyReply {
  if (!isHtmx(req)) return reply.redirect(url, 303);
  return reply.header("HX-Redirect", url).code(204).send();
}
