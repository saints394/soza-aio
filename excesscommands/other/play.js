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
        const createPlayer = () => withTimeout(
            client.riffy.createConnection({
                guildId,
                voiceChannel: voiceChannel.id,
                textChannel: message.channel.id,
                deaf: true
            }),
            15000,
            'Lavalink voice connection'
        );
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

            let player = client.riffy.players.get(guildId);
            if (!player) {
                player = await createPlayer();
            }

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
                await withTimeout(player.play(), 15000, 'Lavalink playback');
            }

            return { player, track };
        };

        try {
            let result;
            try {
                result = await playAttempt(false);
            } catch (firstError) {
                console.warn('[RIFFY] First playback attempt failed; rebuilding the player:', firstError.message);
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
                '❌ I could not play that track. I reset the stale player automatically; please try the command again.'
            );
        }
    }
};