module.exports = {
    distubeOptions: {
        emitAddListWhenCreatingQueue: true,
        emitAddSongWhenCreatingQueue: false,
        emitNewSongOnly: true,
        joinNewVoiceChannel: true,
        nsfw: true,
        savePreviousSongs: true,
        // Leave headroom so tracks mastered near 0 dBFS do not clip when
        // DisTube applies its gain to the Discord voice stream.
        volume: 90,
    }
};
