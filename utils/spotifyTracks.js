const SpotifyWebApi = require('spotify-web-api-node');

const spotifyApi = new SpotifyWebApi({
    clientId: process.env.SPOTIFY_CLIENT_ID || '',
    clientSecret: process.env.SPOTIFY_CLIENT_SECRET || ''
});

let tokenExpiresAt = 0;

function parseSpotifyUrl(value) {
    const match = String(value || '').match(
        /spotify\.com\/(?:intl-[^/]+\/)?(track|playlist|album)\/([A-Za-z0-9]+)/i
    );

    return match
        ? { type: match[1].toLowerCase(), id: match[2] }
        : null;
}

async function ensureSpotifyToken() {
    if (!process.env.SPOTIFY_CLIENT_ID || !process.env.SPOTIFY_CLIENT_SECRET) {
        throw new Error('SPOTIFY_CLIENT_ID and SPOTIFY_CLIENT_SECRET are required for Spotify playlists and albums');
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
        const items = response.body?.items || [];
        tracks.push(...items.map(item => item?.track || item).filter(Boolean));

        if (items.length < pageSize) break;
        offset += pageSize;
    }

    return tracks;
}

async function getSpotifyTrackQueries(url) {
    const parsed = parseSpotifyUrl(url);
    if (!parsed) return null;

    await ensureSpotifyToken();

    if (parsed.type === 'track') {
        const response = await spotifyApi.getTrack(parsed.id);
        return {
            type: parsed.type,
            name: response.body?.name || 'Spotify Track',
            queries: [toSearchQuery(response.body)].filter(Boolean)
        };
    }

    if (parsed.type === 'playlist') {
        const playlist = await spotifyApi.getPlaylist(parsed.id, { fields: 'name' });
        const tracks = await getPage(({ limit, offset }) =>
            spotifyApi.getPlaylistTracks(parsed.id, { limit, offset })
        );

        return {
            type: parsed.type,
            name: playlist.body?.name || 'Spotify Playlist',
            queries: tracks.map(toSearchQuery).filter(Boolean)
        };
    }

    const album = await spotifyApi.getAlbum(parsed.id);
    const tracks = await getPage(({ limit, offset }) =>
        spotifyApi.getAlbumTracks(parsed.id, { limit, offset }),
        50
    );

    return {
        type: parsed.type,
        name: album.body?.name || 'Spotify Album',
        queries: tracks.map(toSearchQuery).filter(Boolean)
    };
}

module.exports = {
    getSpotifyTrackQueries,
    parseSpotifyUrl
};