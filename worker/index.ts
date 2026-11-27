// The Worker entry. It may only have a default export: the runtime treats every named export
// here as an entrypoint. Importing the config checks it, so a Worker with an invalid
// stackhush.config.ts fails to start (and Cloudflare refuses the deploy) with the list of
// problems.

import config from '../stackhush.config.ts';
import { createWorker } from './app.ts';

export default createWorker(config, fetch);
