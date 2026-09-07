const DEFAULT_MUSIC_VOLUME = 90;

function getDefaultMusicVolume() {
    const configured = Number.parseInt(process.env.MUSIC_DEFAULT_VOLUME, 10);
    if (!Number.isFinite(configured)) return DEFAULT_MUSIC_VOLUME;
    return Math.max(0, Math.min(100, configured));
}

function setStablePlayerVolume(player) {
    if (!player || typeof player.setVolume !== 'function') return null;

    const volume = getDefaultMusicVolume();
    player.setVolume(volume);
    return volume;
}

function hasActiveRiffyPlayer(client, guildId) {
    const player = client?.riffy?.players?.get(guildId);
    return Boolean(player && (player.current || player.playing || player.paused));
}

function hasActiveDisTubeQueue(client, guildId) {
    const queue = client?.distube?.getQueue?.(guildId);
    return Boolean(queue && queue.songs?.length);
}

module.exports = {
    getDefaultMusicVolume,
    setStablePlayerVolume,
    hasActiveRiffyPlayer,
    hasActiveDisTubeQueue
};