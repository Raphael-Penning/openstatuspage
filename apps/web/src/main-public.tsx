/**
 * Entry of public.html: the public status page only. APP_ROLE=public instances
 * serve this page and none of the chunks that only the management UI loads.
 */
import { boot } from './boot';
import { publicOnlyRoutes } from './public-router';

boot(publicOnlyRoutes);
