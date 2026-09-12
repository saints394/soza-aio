---
name: Spotify playlist playback
description: Spotify collection loading can use public metadata when Web API credentials are unavailable.
---

Public Spotify playlist and album metadata may still be readable through `spotify-url-info` when Spotify Web API credentials are missing or rejected, but removed or private links can return a Spotify page-not-found response. Keep API loading as the preferred path and public metadata as a fallback.

**Why:** The imported bot's collection playback failed before queueing because it required Spotify API credentials for every Spotify URL, while valid public collections can expose enough metadata for Lavalink searches without them.

**How to apply:** Preserve Spotify item order when converting metadata to search queries, and distinguish invalid/private links from missing credentials in user-facing errors.