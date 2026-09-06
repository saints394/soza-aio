const mongoose = require('mongoose');

const voicePresenceSchema = new mongoose.Schema(
    {
        guildId: {
            type: String,
            required: true,
            unique: true,
            index: true
        },
        channelId: {
            type: String,
            default: null
        },
        enabled: {
            type: Boolean,
            default: true
        },
        mode247: {
            type: Boolean,
            default: false,
            index: true
        },
        requestedBy: {
            type: String,
            default: null
        }
    },
    { timestamps: true }
);

module.exports = mongoose.models.VoicePresence ||
    mongoose.model('VoicePresence', voicePresenceSchema);