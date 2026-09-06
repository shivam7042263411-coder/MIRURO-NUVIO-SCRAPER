/*
 * Diagnostic provider for Nuvio - NO network calls.
 *
 * Purpose: verify that Nuvio can load this repo, run a provider, and render
 * its stream. If "Diagnostic-Fixed" appears as a source for any title, the
 * repo + stream shape + manifest are all working, and any "no stream found"
 * from the real provider is caused by its network logic. If even this shows
 * nothing, the repo is stale/cached in Nuvio or the manifest is not loading.
 */
function getStreams(tmdbId, mediaType, seasonNum, episodeNum) {
  var id = String(tmdbId || "").trim();
  return Promise.resolve([
    {
      name: "Diagnostic-Fixed",
      title: "tv=" + String(mediaType) + " id=" + id,
      url: "https://test-streams.mux.dev/x36xhzz/x36xhzz.m3u8",
      quality: "Auto",
      type: "direct",
      headers: { "User-Agent": "Mozilla/5.0" }
    }
  ]);
}

if (typeof module !== "undefined" && module.exports) {
  module.exports = { getStreams };
} else {
  global.getStreams = getStreams;
}