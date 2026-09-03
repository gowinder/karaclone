import { router } from "./base.js";
import { apiKeysRouter } from "./routers/api-keys.js";
import { bookmarksRouter } from "./routers/bookmarks.js";
import { configRouter } from "./routers/config.js";
import { usersRouter } from "./routers/users.js";

export const appRouter = router({
  config: configRouter,
  apiKeys: apiKeysRouter,
  users: usersRouter,
  bookmarks: bookmarksRouter,
});

export type AppRouter = typeof appRouter;
