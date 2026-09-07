const { PermissionFlagsBits } = require('discord.js');

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

async function waitForConnectedNode(client, timeoutMs = 15000) {
    const startedAt = Date.now();

    while (Date.now() - startedAt < timeoutMs) {
        const node = client.riffy?.leastUsedNodes?.[0];
        if (node?.connected) return node;

        await new Promise(resolve => setTimeout(resolve, 250));
    }

    throw new Error('No Lavalink nodes are connected');
}

async function waitForPlayerReady(player, timeoutMs = 15000) {
    if (!player?.connection) {
        throw new Error('Lavalink player connection is unavailable');
    }

    await withTimeout(
        player.connection.resolve(),
        timeoutMs,
        'Discord voice credentials'
    );

    if (!player.connection.isReady) {
        throw new Error('Discord voice credentials are not ready');
    }

    if (!player.node?.connected) {
        throw new Error('Lavalink node disconnected while joining voice');
    }

    return player;
}

function canReusePlayer(player, voiceChannelId) {
    return Boolean(
        player &&
        player.voiceChannel === voiceChannelId &&
        player.connected &&
        player.node?.connected
    );
}

function isConnectionFailure(error) {
    const message = String(error?.message || error || '').toLowerCase();
    return [
        'connection',
        'voice',
        'node',
        'credential',
        'timeout',
        'timed out',
        'no lavalink'
    ].some(term => message.includes(term));
}

function getPlaybackFailureMessage(error) {
    const message = String(error?.message || error || '').toLowerCase();

    if (message.includes('no lavalink nodes')) {
        return 'Tidak ada server Lavalink yang sedang online.';
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
            const createPlayer = () => {
                return waitForConnectedNode(client).then(() => withTimeout(
                    client.riffy.createConnection({
                        guildId,
                        voiceChannel: voiceChannel.id,
                        textChannel: message.channel.id,
                        deaf: true
                    }),
                    15000,
                    'Lavalink voice connection'
                ));
            };
            const resolveTrack = () => withTimeout(
                client.riffy.resolve({
                    query,
                    requester: message.author
                }),
                20000,
                'Track search'
            );

            const playAttempt = async (forceFresh) => {
                if (forceFresh) {
                    destroyGuildPlayer(client, guildId);
                }

                await waitForConnectedNode(client);

                let player = client.riffy.players.get(guildId);
                if (!canReusePlayer(player, voiceChannel.id)) {
                    if (player) destroyGuildPlayer(client, guildId);
                    player = await createPlayer();
                }

                // createConnection() only sends the Discord voice state. The
                // voice credentials arrive asynchronously through raw gateway
                // events, so wait for them before resolving or playing.
                await waitForPlayerReady(player);

                const result = await resolveTrack();
                if (!result?.tracks?.length) {
                    return { player, track: null };
                }

                const track = result.tracks[0];
                track.requester = {
                    id: message.author.id,
                    username: message.author.username,
                    avatarURL: message.author.displayAvatarURL()
                };

                player.queue.add(track);
                if (!player.playing && !player.paused) {
                    await withTimeout(player.play(), 20000, 'Lavalink playback');
                }

                return { player, track };
            };

            try {
                let result;
                try {
                    result = await playAttempt(false);
                } catch (firstError) {
                    if (!isConnectionFailure(firstError)) throw firstError;

                    console.warn('[RIFFY] Voice connection was not ready; rebuilding the player:', firstError.message);
                    result = await playAttempt(true);
                }

                if (!result.track) {
                    return temporaryReply(message, `❌ No tracks found for **${query}**.`);
                }

                const position = result.player.queue.length;
                const reply = await message.reply(
                    `🎵 Added **${result.track.info.title}** to the queue.\n📍 Position: **#${position}**`
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