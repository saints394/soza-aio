const { getData } = require('spotify-url-info')(fetch);

function parseSpotifyUrl(value) {
    const input = String(value || '').trim();

    try {
        const url = new URL(input);
        if (!/spotify(?:\.com)?$/i.test(url.hostname) &&
            !/\.spotify\.com$/i.test(url.hostname)) {
            return null;
        }

        const parts = url.pathname.split('/').filter(Boolean);
        const typeIndex = parts.findIndex(part => /^(track|playlist|album)$/i.test(part));
        const type = typeIndex >= 0 ? parts[typeIndex].toLowerCase() : null;
        const id = type ? parts[typeIndex + 1]?.match(/^[A-Za-z0-9]+/)?.[0] : null;

        return type && id ? { type, id } : null;
    } catch {
        return null;
    }
}

function toSearchQuery(track) {
    if (!track?.name || !Array.isArray(track.artists)) return null;
    const artists = track.artists.map(artist => artist?.name).filter(Boolean).join(', ');
    return artists ? `${track.name} - ${artists}` : track.name;
}

function buildTrackResponse(parsed, name, tracks) {
    return {
        type: parsed.type,
        name: name || `Spotify ${parsed.type}`,
        queries: tracks.map(toSearchQuery).filter(Boolean)
    };
}

async function getSpotifyTrackQueriesFromPublicMetadata(url, parsed) {
    const data = await getData(url);
    const tracks = parsed.type === 'track'
        ? [{
            name: data?.title || data?.name,
            artists: Array.isArray(data?.artists) ? data.artists : []
        }]
        : Array.isArray(data?.trackList)
            ? data.trackList
                .filter(track => track?.title)
                .map(track => ({
                    name: track.title,
                    artists: track.subtitle
                        ? track.subtitle.split(',').map(name => ({ name: name.trim() })).filter(artist => artist.name)
                        : []
                }))
            : [];

    return buildTrackResponse(parsed, data?.title, tracks);
}

async function getSpotifyTrackQueries(url) {
    const parsed = parseSpotifyUrl(url);
    if (!parsed) return null;

    // Spotify's public page metadata contains the title and artist data needed
    // to search Lavalink. This avoids requiring Spotify API credentials.
    return getSpotifyTrackQueriesFromPublicMetadata(url, parsed);
}

module.exports = {
    getSpotifyTrackQueries,
    parseSpotifyUrl
};