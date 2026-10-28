// Shared app state, filled in by app.js once a server session is live.
export const ctx = {
  api: null,
  user: null,
  server: null,
  views: [],
  play: async () => {},
  refresh: () => {},
};
