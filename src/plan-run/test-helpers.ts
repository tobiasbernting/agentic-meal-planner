import type { FastifyInstance } from "fastify";

/**
 * Waits until the week's Plan Run banner stops polling, i.e. no run is in flight. Goes over
 * HTTP like the browser does, so tests never read the registry.
 */
export async function planRunSettled(app: FastifyInstance, weekStart: string): Promise<void> {
  for (let i = 0; i < 500; i++) {
    const banner = await app.inject({ method: "GET", url: `/plan-run/banner?week=${weekStart}` });
    if (!banner.body.includes("hx-trigger")) return;
    await new Promise((resolve) => setTimeout(resolve, 2));
  }
  throw new Error(`Plan Run for ${weekStart} still in flight`);
}

/** POSTs a Plan Run start (`/plan/generate` or `/plan/regenerate`) and waits for the run to end. */
export async function postPlanRun(app: FastifyInstance, url: string, payload: Record<string, string>) {
  const res = await app.inject({ method: "POST", url, payload });
  await planRunSettled(app, payload.weekStart!);
  return res;
}
