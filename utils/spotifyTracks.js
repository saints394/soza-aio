const SpotifyWebApi = require('spotify-web-api-node');
const { getData } = require('spotify-url-info')(fetch);

const spotifyApi = new SpotifyWebApi({
    clientId: process.env.SPOTIFY_CLIENT_ID || '',
    clientSecret: process.env.SPOTIFY_CLIENT_SECRET || ''
});

let tokenExpiresAt = 0;

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

async function ensureSpotifyToken() {
    if (!process.env.SPOTIFY_CLIENT_ID || !process.env.SPOTIFY_CLIENT_SECRET) {
        throw new Error('SPOTIFY_CLIENT_ID and SPOTIFY_CLIENT_SECRET are not configured');
    }

    if (Date.now() < tokenExpiresAt) return;

    const token = await spotifyApi.clientCredentialsGrant();
    spotifyApi.setAccessToken(token.body.access_token);
    tokenExpiresAt = Date.now() + Math.max((token.body.expires_in - 60) * 1000, 60000);
}

function toSearchQuery(track) {
    if (!track?.name || !Array.isArray(track.artists)) return null;
    const artists = track.artists.map(artist => artist?.name).filter(Boolean).join(', ');
    return artists ? `${track.name} - ${artists}` : track.name;
}

async function getPage(fetchPage, pageSize = 100) {
    const tracks = [];
    let offset = 0;

    while (true) {
        const response = await fetchPage({ limit: pageSize, offset });
        const body = response.body || {};
        const items = body.items || [];
        tracks.push(...items.map(item => item?.track || item).filter(Boolean));

        if (!body.next || items.length === 0) break;
        offset += pageSize;
    }

    return tracks;
}

function buildTrackResponse(parsed, name, tracks) {
    return {
        type: parsed.type,
        name: name || `Spotify ${parsed.type}`,
        queries: tracks.map(toSearchQuery).filter(Boolean)
    };
}

async function getSpotifyTrackQueriesFromApi(parsed) {
    await ensureSpotifyToken();

    if (parsed.type === 'track') {
        const response = await spotifyApi.getTrack(parsed.id);
        return buildTrackResponse(parsed, response.body?.name, [response.body]);
    }

    if (parsed.type === 'playlist') {
        const playlist = await spotifyApi.getPlaylist(parsed.id, { fields: 'name' });
        const tracks = await getPage(({ limit, offset }) =>
            spotifyApi.getPlaylistTracks(parsed.id, { limit, offset })
        );
        return buildTrackResponse(parsed, playlist.body?.name, tracks);
    }

    const album = await spotifyApi.getAlbum(parsed.id);
    const tracks = await getPage(({ limit, offset }) =>
        spotifyApi.getAlbumTracks(parsed.id, { limit, offset }),
        50
    );
    return buildTrackResponse(parsed, album.body?.name, tracks);
}

async function getSpotifyTrackQueriesFromPublicMetadata(url, parsed) {
    const data = await getData(url);
    const tracks = Array.isArray(data?.trackList)
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

    try {
        return await getSpotifyTrackQueriesFromApi(parsed);
    } catch (apiError) {
        // Spotify's public metadata endpoint can still expose public playlists
        // and albums when API credentials are missing, expired, or rejected.
        try {
            const result = await getSpotifyTrackQueriesFromPublicMetadata(url, parsed);
            if (result.queries.length) return result;
        } catch (metadataError) {
            apiError.publicMetadataError = metadataError;
        }

        throw apiError;
    }
}

module.exports = {
    getSpotifyTrackQueries,
    parseSpotifyUrl
};