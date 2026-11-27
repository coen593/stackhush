// The Worker's two handlers for a given config. Kept out of worker/index.ts so tests can make a
// Worker with a config of their own instead of the installed stackhush.config.ts.

import { handleRequest } from './api.ts';
import type { Config } from './config.ts';
import { emptyResponse } from './responses.ts';
import { runChecks } from './run.ts';
import type { Fetcher } from './sources/http.ts';

/** `fetcher` is how the Worker reaches the outside: `fetch` for real, a fake one in tests. */
export function createWorker(config: Config, fetcher: Fetcher) {
  return {
    // Typed as a plain Request (not Cloudflare's incoming one) so tests can call it directly.
    // Only /api/* reaches the Worker (run_worker_first); everything else is a static asset.
    async fetch(request: Request, env: Env): Promise<Response> {
      try {
        return await handleRequest(request, env, new Date(), config, fetcher);
      } catch (error) {
        console.error('Unhandled error', error);
        return emptyResponse(500);
      }
    },

    // The only caller of runChecks: the cron trigger. No HTTP route leads to it.
    async scheduled(controller: ScheduledController, env: Env): Promise<void> {
      await runChecks(env, new Date(controller.scheduledTime), config, fetcher);
    },
  } satisfies ExportedHandler<Env>;
}
