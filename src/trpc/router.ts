import { router } from "./base.js";
import { apiKeysRouter } from "./routers/api-keys.js";
import { assetsRouter } from "./routers/assets.js";
import { bookmarksRouter } from "./routers/bookmarks.js";
import { configRouter } from "./routers/config.js";
import { highlightsRouter } from "./routers/highlights.js";
import { listsRouter } from "./routers/lists.js";
import { rulesRouter } from "./routers/rules.js";
import { tagsRouter } from "./routers/tags.js";
import { llmRouter } from "./routers/llm.js";
import { usersRouter } from "./routers/users.js";

export const appRouter = router({
  config: configRouter,
  apiKeys: apiKeysRouter,
  users: usersRouter,
  bookmarks: bookmarksRouter,
  lists: listsRouter,
  highlights: highlightsRouter,
  rules: rulesRouter,
  tags: tagsRouter,
  llm: llmRouter,
  assets: assetsRouter,
});

export type AppRouter = typeof appRouter;
