---
name: Spotify playlist playback
description: Spotify collection loading can use public metadata when Web API credentials are unavailable.
---

Playback commands use public Spotify page metadata through `spotify-url-info` as their primary source, so Spotify Web API credentials are not required. Removed or private links can still return a Spotify page-not-found response.

**Why:** The imported bot's playback failed before queueing because it required Spotify API credentials for every Spotify URL, while valid public collections expose enough metadata for Lavalink searches without them.

**How to apply:** Preserve Spotify item order when converting metadata to search queries, and describe failures as inactive/private links rather than asking playback users for credentials. Other Spotify browsing commands may still use the separate Web API integration.