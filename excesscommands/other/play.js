const { PermissionFlagsBits } = require('discord.js');
const { getSpotifyTrackQueries, parseSpotifyUrl } = require('../../utils/spotifyTracks');

function temporaryReply(message, content, timeout = 6000) {
    return message.reply(content).then(reply => {
        setTimeout(() => reply.delete().catch(() => {}), timeout);
        return reply;
    });
}

function withTimeout(promise, timeoutMs, label) {
    let timer;
    const timeout = new Promise((_, reject) => {
        timer = setTimeout(() => {
            reject(new Error(`${label} timed out after ${timeoutMs}ms`));
        }, timeoutMs);
    });

    return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

const guildPlayLocks = new Map();
const nodeHealthCache = new WeakMap();
let nodeResolutionQueue = Promise.resolve();

function withGuildPlayLock(guildId, task) {
    const previous = guildPlayLocks.get(guildId) || Promise.resolve();
    const current = previous.catch(() => {}).then(task);
    guildPlayLocks.set(guildId, current);

    return current.finally(() => {
        if (guildPlayLocks.get(guildId) === current) {
            guildPlayLocks.delete(guildId);
        }
    });
}

function destroyGuildPlayer(client, guildId) {
    const player = client.riffy?.players.get(guildId);
    if (!player) return;

    try {
        player.destroy();
    } catch (error) {
        console.warn(`[RIFFY] Could not destroy stale player for ${guildId}:`, error.message);
    }

    if (client.riffy.players.get(guildId) === player) {
        client.riffy.players.delete(guildId);
    }
}

function withNodeResolutionLock(task) {
    const run = nodeResolutionQueue.then(task);
    nodeResolutionQueue = run.catch(() => {});
    return run;
}

function markNodeUnhealthy(node, error) {
    if (!node) return;

    nodeHealthCache.set(node, {
        healthy: false,
        checkedAt: Date.now(),
        error: error?.message || String(error || 'Unknown node failure')
    });
}

async function checkNodeHealth(node) {
    if (!node?.connected || !node.rest?.getStats) return false;

    const cached = nodeHealthCache.get(node);
    if (cached && Date.now() - cached.checkedAt < 30000) {
        return cached.healthy;
    }

    try {
        await withTimeout(
            node.rest.getStats(),
            5000,
            `Lavalink node health check (${node.name})`
        );
        nodeHealthCache.set(node, { healthy: true, checkedAt: Date.now() });
        return true;
    } catch (error) {
        markNodeUnhealthy(node, error);
        console.warn(`[RIFFY] Node ${node.name} failed health check:`, error.message);
        return false;
    }
}

async function waitForHealthyNode(client, timeoutMs = 15000, excludedNodes = new Set()) {
    const startedAt = Date.now();

    while (Date.now() - startedAt < timeoutMs) {
        const candidates = (client.riffy?.leastUsedNodes || [])
            .filter(node => !excludedNodes.has(node))
            .sort((a, b) => (a.rest?.calls || 0) - (b.rest?.calls || 0));

        for (const node of candidates) {
            if (await checkNodeHealth(node)) return node;
        }

        await new Promise(resolve => setTimeout(resolve, 250));
    }

    throw new Error('No healthy Lavalink nodes are available');
}

function isUsablePlayer(player, voiceChannelId) {
    return Boolean(
        player &&
        player.voiceChannel === voiceChannelId &&
        player.connected &&
        player.node?.connected
    );
}

function getPlaybackFailureMessage(error) {
    const message = String(error?.message || error || '').toLowerCase();

    if (message.includes('no lavalink nodes')) {
        return 'Tidak ada server Lavalink yang sedang online.';
    }

    if (message.includes('no healthy lavalink nodes')) {
        return 'Tidak ada server Lavalink yang merespons dengan sehat.';
    }

    if (message.includes('track search')) {
        return 'Server Lavalink tidak merespons pencarian lagu.';
    }

    if (message.includes('lavalink playback')) {
        return 'Server Lavalink tidak merespons saat memulai audio.';
    }

    if (message.includes('timed out') || message.includes('timeout')) {
        return 'Koneksi voice atau Lavalink belum siap. Tunggu beberapa detik lalu coba lagi.';
    }

    if (message.includes('no matches') || message.includes('load failed')) {
        return 'Lavalink tidak dapat menemukan atau memuat lagu tersebut.';
    }

    return 'Server musik gagal memproses lagu tersebut. Coba lagi sebentar lagi.';
}

module.exports = {
    async execute(message, args, client) {
        const query = args.join(' ').trim();
        if (!query) {
            return temporaryReply(message, '❌ Please provide a song name or URL.\nExample: `.play royalty`');
        }

        const voiceChannel = message.member?.voice?.channel;
        if (!voiceChannel) {
            return temporaryReply(message, '❌ Join a voice channel first, then use `.play <song>`.');
        }

        const botVoiceChannel = message.guild.members.me?.voice?.channel;
        if (botVoiceChannel && botVoiceChannel.id !== voiceChannel.id) {
            return temporaryReply(message, '❌ I am already playing music in another voice channel.');
        }

        const permissions = voiceChannel.permissionsFor(client.user);
        if (
            !permissions?.has(PermissionFlagsBits.Connect) ||
            !permissions.has(PermissionFlagsBits.Speak)
        ) {
            return temporaryReply(message, '❌ I need **Connect** and **Speak** permission in that voice channel.');
        }

        if (!client.riffy) {
            return temporaryReply(message, '❌ The music system is not ready yet. Please try again shortly.');
        }

        const guildId = message.guild.id;
        return withGuildPlayLock(guildId, async () => {
        let spotifyRequest = null;
        try {
            if (parseSpotifyUrl(query)) {
                spotifyRequest = await getSpotifyTrackQueries(query);
                if (!spotifyRequest?.queries?.length) {
                    return temporaryReply(message, '❌ Playlist atau album Spotify itu tidak berisi lagu yang bisa diputar.');
                }
            }
        } catch (error) {
            console.error('Spotify collection load error:', error);
            const spotifyMessage = error.message.includes('not configured')
                ? 'Tambahkan SPOTIFY_CLIENT_ID dan SPOTIFY_CLIENT_SECRET, atau gunakan link Spotify publik yang bisa dibaca.'
                : 'Pastikan link Spotify masih aktif dan playlist/album tidak private.';
            return temporaryReply(
                message,
                `❌ Playlist/album Spotify tidak bisa dibaca.\n${spotifyMessage}`
            );
        }

            const createPlayer = (node) => withTimeout(
                    client.riffy.createPlayer(node, {
                        guildId,
                        voiceChannel: voiceChannel.id,
                        textChannel: message.channel.id,
                        deaf: true
                    }),
                    15000,
                    'Lavalink voice connection'
                );

            const resolveTrack = (node, searchQuery = query) => withNodeResolutionLock(async () => {
                const previousNode = client.riffy.nodeByRegion;
                client.riffy.nodeByRegion = node;

                try {
                    return await withTimeout(
                        client.riffy.resolve({
                            query: searchQuery,
                            requester: message.author
                        }),
                        20000,
                        'Track search'
                    );
                } finally {
                    if (client.riffy.nodeByRegion === node) {
                        client.riffy.nodeByRegion = previousNode;
                    }
                }
            });

            let lastAttemptNode = null;
            const playAttempt = async (forceFresh, excludedNodes) => {
                lastAttemptNode = null;

                if (forceFresh) {
                    destroyGuildPlayer(client, guildId);
                }

                let player = client.riffy.players.get(guildId);
                if (isUsablePlayer(player, voiceChannel.id) && await checkNodeHealth(player.node)) {
                    lastAttemptNode = player.node;
                } else {
                    if (player) destroyGuildPlayer(client, guildId);
                    lastAttemptNode = await waitForHealthyNode(client, 15000, excludedNodes);
                    player = await createPlayer(lastAttemptNode);
                }

                const queries = spotifyRequest?.queries || [query];
                const tracks = [];
                let lastTrackError = null;

                for (const searchQuery of queries) {
                    try {
                        const result = await resolveTrack(lastAttemptNode, searchQuery);
                        if (result?.tracks?.length) {
                            const track = result.tracks[0];
                            track.requester = {
                                id: message.author.id,
                                username: message.author.username,
                                avatarURL: message.author.displayAvatarURL()
                            };
                            tracks.push(track);
                        }
                    } catch (error) {
                        lastTrackError = error;
                        console.warn(`[RIFFY] Could not resolve "${searchQuery}":`, error.message);
                    }
                }

                if (!tracks.length && lastTrackError) throw lastTrackError;
                if (!tracks.length) return { player, track: null, tracks };

                for (const track of tracks) player.queue.add(track);
                if (!player.playing && !player.paused) {
                    await withTimeout(player.play(), 20000, 'Lavalink playback');
                }

                return { player, track: tracks[0], tracks };
            };

            try {
                const failedNodes = new Set();
                let result = null;
                let lastError = null;

                for (let attempt = 0; attempt < 3; attempt++) {
                    try {
                        result = await playAttempt(attempt > 0, failedNodes);
                        lastError = null;
                        break;
                    } catch (attemptError) {
                        lastError = attemptError;

                        if (lastAttemptNode) {
                            failedNodes.add(lastAttemptNode);
                            markNodeUnhealthy(lastAttemptNode, attemptError);
                            console.warn(
                                `[RIFFY] Playback attempt ${attempt + 1} failed on ${lastAttemptNode.name}:`,
                                attemptError.message
                            );
                        } else {
                            console.warn(
                                `[RIFFY] Playback attempt ${attempt + 1} failed before node selection:`,
                                attemptError.message
                            );
                        }

                        destroyGuildPlayer(client, guildId);
                    }
                }

                if (!result) {
                    throw lastError || new Error('Playback failed after node failover attempts');
                }

                if (!result.track) {
                    return temporaryReply(message, `❌ No tracks found for **${query}**.`);
                }

                const position = result.player.queue.length;
                const addedCount = result.tracks?.length || 1;
                const collectionLabel = spotifyRequest?.type === 'album' ? 'album' : 'playlist';
                const reply = await message.reply(
                    spotifyRequest
                        ? `🎵 Spotify ${collectionLabel} **${spotifyRequest.name}** ditambahkan ke queue.\n✅ **${addedCount}** lagu berhasil ditambahkan.\n📍 Queue sekarang: **${position}** lagu`
                        : `🎵 Added **${result.track.info.title}** to the queue.\n📍 Position: **#${position}**`
                );
                setTimeout(() => reply.delete().catch(() => {}), 6000);
            } catch (error) {
                console.error('Prefix music play error:', error);
                destroyGuildPlayer(client, guildId);
                return temporaryReply(
                    message,
                    `❌ Saya tidak bisa memutar lagu itu.\n${getPlaybackFailureMessage(error)}\n\nCoba lagi setelah beberapa detik.`
                );
            }
        });
    }
};