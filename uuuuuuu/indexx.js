const Discord = require('discord.js-selfbot-v13');
const { Rainlink, Library } = require('rainlink');
const ytSearch = require('yt-search');
const axios = require('axios');
const fs = require('fs');
const filters = require('./core/filters');
const gtts = require('google-tts-api');
const getData = require('spotify-url-info');

// Load configuration
const config = JSON.parse(fs.readFileSync('config.json', 'utf-8'));

// Read tokens from file
const tokens = fs.readFileSync('token.txt', 'utf-8').split('\n').filter(Boolean);
if (!tokens.length) {
    console.error("No tokens found in token.txt");
    process.exit(1);
}

async function initClient(token) {
    const client = new Discord.Client({
        readyStatus: false,
        checkUpdate: false,
        partials: ['CHANNEL', 'MESSAGE']
    });

    // Mask token in logs
    const maskedToken = `${token.slice(0, 5)}...${token.slice(-3)}`;
    
    client.once('ready', () => {
        console.log(`[LOGIN] Logged in as ${client.user.tag} (Token: ${maskedToken})`);
    });

    const rainlink = new Rainlink({
        library: new Library.DiscordJS(client),
        nodes: [{
            name: 'Lavalink',
            host: config.lavalink.host,
            port: config.lavalink.port,
            auth: config.lavalink.password,
            secure: config.lavalink.secure,
            driver: 'lavalink'
        }]
    });

    // Handle rainlink connection errors
    rainlink.on('nodeConnect', (node) => {
        console.log(`[RAINLINK][${client.user.tag}] Connected to node: ${node.name}`);
    });

    rainlink.on('nodeError', (node, error) => {
        console.error(`[RAINLINK ERROR][${client.user.tag}] Node ${node.name}:`, error);
    });

    rainlink.on('nodeDisconnect', (node, reason) => {
        console.warn(`[RAINLINK][${client.user.tag}] Node ${node.name} disconnected:`, reason);
    });

    // Event listeners
    rainlink.on('trackStart', (player, track) => {
        startTrackMonitor(player, track);
    });

    rainlink.on('trackEnd', async (player, track, reason) => {
        const guildId = player.guildId;
        const loop = loopType.get(guildId) || 'off';

        if (reason === 'FINISHED') {
            if (loop === 'track') {
                // Replay the same track
                player.queue.unshift(track);
                await player.play();
            } else if (loop === 'queue' && player.queue.size > 0) {
                // Add the queue again
                const queueCopy = [...player.queue];
                player.queue.clear();
                queueCopy.forEach(t => player.queue.add(t));
                await player.play();
            } else if (autoplayStatus.get(guildId) && player.queue.size === 0) {
                triggerAutoplay(guildId, player, track).catch(console.error);
            }
        }
    });

    // State management
    const autoplayStatus = new Map();
    const autoplayHistory = new Map();
    const activeTrackMonitors = new Map();
    const lastKnownStates = new Map();
    const lofiStatus = new Map();
    const autoplayInProgress = new Map();
    const pausedPlayers = new Map();
    const loopType = new Map(); // 'off', 'track', 'queue'
    const ttsStatus = new Map(); // true/false

    // Utility functions
    function formatTime(ms) {
        if (!ms || ms <= 0) return '00:00';
        const seconds = Math.floor(ms / 1000) % 60;
        const minutes = Math.floor(ms / 60000);
        return `${minutes.toString().padStart(2, '0')}:${seconds.toString().padStart(2, '0')}`;
    }

    function createProgressBar(current, total, size = 20) {
        if (!total || total <= 0) return '🔴' + '─'.repeat(size);
        const progress = Math.round((current / total) * size);
        return '▬'.repeat(progress) + '🔘' + '▬'.repeat(size - progress);
    }

    async function resolveSpotify(query) {
        if (!query.includes('spotify.com')) return null;
        try {
            const data = await getData(query);
            if (data.type === 'track') {
                return `${data.name} ${data.artists.map(a => a.name).join(' ')}`;
            } else if (data.type === 'playlist' || data.type === 'album') {
                return data.tracks.items.map(track => `${track.name} ${track.artists.map(a => a.name).join(' ')}`);
            }
        } catch (err) {
            console.error('Spotify resolve error:', err);
        }
        return null;
    }

    async function fetchYouTubeDuration(videoId) {
        // Duration is usually available from the track itself, so we return 0 if not available
        // This avoids needing a YouTube API key
        return 0;
    }

    function startGlobalMonitor() {
        console.log(`[SYSTEM][${client.user.tag}] Starting global player monitor`);
        setInterval(() => {
            try {
                const players = rainlink.players.collection;
                if (!players?.size) return;
                players.forEach((player, guildId) => {
                    checkPlayerState(player, guildId);
                });
            } catch (err) {
                console.error(`[MONITOR ERROR][${client.user.tag}]`, err);
            }
        }, 2000);
    }

    function checkPlayerState(player, guildId) {
        if (!player || !guildId) return;

        const currentTrack = player.queue.current;
        const newState = {
            trackId: currentTrack?.identifier,
            isPlaying: player.playing,
            queueSize: player.queue.size,
            position: player.position,
            lastUpdate: Date.now()
        };

        const lastState = lastKnownStates.get(guildId) || {};
        
        if (lastState.isPlaying && !newState.isPlaying && newState.queueSize === 0 && 
            autoplayStatus.get(guildId) && currentTrack?.identifier) {
            triggerAutoplay(guildId, player, player.queue.previous || currentTrack).catch(console.error);
        }

        lastKnownStates.set(guildId, newState);
    }

    // Track monitoring
    function startTrackMonitor(player, track) {
        if (!player || !track?.identifier) return;

        const guildId = player.guildId;
        stopTrackMonitor(guildId);

        const timeToEnd = Math.max(1000, track.length - 10000);
        const monitorId = setTimeout(() => {
            const endCheckInterval = setInterval(() => {
                const currentPlayer = rainlink.players.get(guildId);
                if (!currentPlayer) return clearInterval(endCheckInterval);

                if (!currentPlayer.playing || currentPlayer.queue.current?.identifier !== track.identifier) {
                    clearInterval(endCheckInterval);
                    if (autoplayStatus.get(guildId) && currentPlayer.queue.size === 0) {
                        triggerAutoplay(guildId, currentPlayer, track).catch(console.error);
                    }
                }
            }, 500);
            activeTrackMonitors.set(guildId, endCheckInterval);
        }, timeToEnd);

        activeTrackMonitors.set(guildId, monitorId);
    }

    function stopTrackMonitor(guildId) {
        const monitorId = activeTrackMonitors.get(guildId);
        if (monitorId) {
            clearTimeout(monitorId);
            clearInterval(monitorId);
            activeTrackMonitors.delete(guildId);
        }
    }

    // Autoplay functionality
    async function fetchAutoplayRecommendations(videoId, cap = 7) {
        if (!videoId) return [];
        
        try {
            const res = await axios.get(`https://www.youtube.com/watch?v=${videoId}&list=RD${videoId}`, {
                headers: { 'User-Agent': 'Mozilla/5.0' }
            });
            const ytData = JSON.parse(res.data.match(/ytInitialData\s*=\s*(\{.*?\});/s)?.[1] || '{}');
            
            return (ytData?.contents?.twoColumnWatchNextResults?.playlist?.playlist?.contents || [])
                .slice(0, cap)
                .map(item => {
                    const v = item.playlistPanelVideoRenderer;
                    if (!v?.videoId || v.videoId === videoId) return null;
                    return {
                        title: v.title?.runs?.[0]?.text || v.title?.simpleText || 'Unknown',
                        identifier: v.videoId,
                        url: `https://www.youtube.com/watch?v=${v.videoId}`
                    };
                })
                .filter(Boolean);
        } catch (err) {
            console.error("Autoplay fetch error:", err);
            return [];
        }
    }

    async function triggerAutoplay(guildId, player, seedTrack) {
        if (autoplayInProgress.get(guildId) || !seedTrack?.identifier) return;
        autoplayInProgress.set(guildId, true);

        try {
            const seedList = await fetchAutoplayRecommendations(seedTrack.identifier);
            if (!seedList.length) return;

            let selected = null;
            for (const r of seedList) {
                try {
                    const found = await player.search(r.url);
                    if (found?.tracks?.[0]) {
                        selected = found.tracks[0];
                        break;
                    }
                } catch (err) {
                    console.error(`[SEARCH ERROR] ${r.url}`, err);
                }
            }

            if (!selected) return;

            player.queue.add(selected);
            if (!player.playing) await player.play();
            startTrackMonitor(player, selected);

            const history = autoplayHistory.get(guildId) || [];
            history.push(selected.identifier);
            if (history.length > 20) history.shift();
            autoplayHistory.set(guildId, history);

            const textChannel = await client.channels.fetch(player.textId);
            if (textChannel) {
                await textChannel.send(`**↻** Now Autoplaying: **${selected.title}**\n\n-# • Powered by Fynex Developments </>`);
            }
        } catch (err) {
            console.error("[AUTOPLAY ERROR]", err);
        } finally {
            setTimeout(() => autoplayInProgress.set(guildId, false), 5000);
        }
    }

    // Helper function to check if message is in DM
    function isDM(message) {
        return !message.guildId;
    }

    // Helper function to find user's voice channel across all guilds
    async function findUserVoiceChannel(userId) {
        for (const [guildId, guild] of client.guilds.cache) {
            try {
                const member = await guild.members.fetch(userId).catch(() => null);
                if (member?.voice?.channel) {
                    return {
                        guild: guild,
                        guildId: guildId,
                        voiceChannel: member.voice.channel,
                        textChannel: null // Will be set based on where command was sent
                    };
                }
            } catch (err) {
                // Continue searching
            }
        }
        return null;
    }

    // Helper function to get or find voice channel for command
    async function getVoiceChannelForCommand(message) {
        // If in guild, use guild voice channel
        if (message.guildId && message.member?.voice?.channel) {
            return {
                guildId: message.guildId,
                voiceChannel: message.member.voice.channel,
                textChannel: message.channelId
            };
        }
        
        // If in DM, find user's voice channel
        if (isDM(message)) {
            const vcInfo = await findUserVoiceChannel(message.author.id);
            if (vcInfo) {
                return {
                    guildId: vcInfo.guildId,
                    voiceChannel: vcInfo.voiceChannel,
                    textChannel: message.channelId // Use DM channel for responses
                };
            }
            return null;
        }
        
        return null;
    }

    // Command handler
    client.on('messageCreate', async (message) => {
        if (message.author.bot || !config.allowedUserIds.includes(message.author.id)) return;
        if (!message.content.startsWith(config.prefix)) return;

        const args = message.content.slice(config.prefix.length).trim().split(/ +/);
        const command = args.shift().toLowerCase();

        try {
            switch (command) {
                case 'ping':
                    await message.reply('🏓 PONG! Powered By Fynex Developments </>');
                    break;

                case 'play': {
                    const query = args.join(' ');
                    if (!query) return message.reply('❌ Please provide a song!');

                    // Get voice channel (works for both DM and guild)
                    const vcData = await getVoiceChannelForCommand(message);
                    if (!vcData) {
                        return message.reply('❌ You need to be in a voice channel! Join a voice channel in any server first.');
                    }

                    const player = await rainlink.create({
                        guildId: vcData.guildId,
                        textId: vcData.textChannel,
                        voiceId: vcData.voiceChannel.id,
                        shardId: 0,
                    });

                    let searchQuery = query;
                    let isPlaylist = false;
                    let tracks = [];

                    // Handle Spotify
                    const spotifyData = await resolveSpotify(query);
                    if (spotifyData) {
                        if (Array.isArray(spotifyData)) {
                            // Playlist or album
                            isPlaylist = true;
                            for (const title of spotifyData) {
                                const ytResult = await ytSearch(title);
                                if (ytResult?.videos?.[0]?.url) {
                                    const result = await player.search(ytResult.videos[0].url);
                                    if (result?.tracks?.[0]) {
                                        tracks.push(result.tracks[0]);
                                    }
                                }
                            }
                        } else {
                            searchQuery = spotifyData;
                        }
                    }

                    if (!isPlaylist) {
                        let result = await player.search(searchQuery);
                        if (!result?.tracks?.length) {
                            const ytResult = await ytSearch(searchQuery);
                            if (ytResult?.videos?.[0]?.url) {
                                result = await player.search(ytResult.videos[0].url);
                            }
                        }

                        if (!result?.tracks?.length) {
                            return message.reply('❌ No results found!');
                        }

                        tracks = result.tracks;
                    }

                    if (tracks.length === 0) {
                        return message.reply('❌ No tracks found!');
                    }

                    // Add all tracks to queue
                    tracks.forEach(track => player.queue.add(track));

                    if (!player.playing) {
                        await player.play();
                    }

                    const addedCount = tracks.length;
                    const firstTrack = tracks[0];
                    await message.reply(isPlaylist ? `🎵 Added ${addedCount} tracks to queue from playlist` : `🎵 Added to queue: **${firstTrack.title}**`);
                    break;
                }

                case 'pause': {
                    const vcData = await getVoiceChannelForCommand(message);
                    const guildId = vcData?.guildId || message.guildId;
                    const player = rainlink.players.get(guildId);
                    if (!player) return message.reply('❌ No music is playing!');
                
                    // Toggle pause/resume
                    if (player.paused) {
                        await player.resume();
                        message.reply('▶️ Resumed playback!');
                    } else {
                        await player.pause();
                        message.reply('⏸️ Playback paused!');
                    }
                    break;
                }

                case 'skip': {
                    const vcData = await getVoiceChannelForCommand(message);
                    const guildId = vcData?.guildId || message.guildId;
                    const player = rainlink.players.get(guildId);
                    if (!player) return message.reply('❌ No music playing!');

                    const trackTitle = player.queue.current?.title || 'current song';
                    stopTrackMonitor(guildId);
                    await player.skip();

                    await message.reply(`⏭ Skipped **${trackTitle}**`);

                    if (autoplayStatus.get(guildId) && player.queue.size === 0 && player.queue.current?.identifier) {
                        setTimeout(() => triggerAutoplay(guildId, player, player.queue.current), 1000);
                    } else if (player.queue.current) {
                        startTrackMonitor(player, player.queue.current);
                    }
                    break;
                }

                case 'stop': {
                    const vcData = await getVoiceChannelForCommand(message);
                    const guildId = vcData?.guildId || message.guildId;
                    const player = rainlink.players.get(guildId);
                    if (!player) return message.reply('❌ No music playing!');

                    stopTrackMonitor(guildId);
                    await player.destroy();
                    await message.reply('⏹ Stopped player');
                    break;
                }

                case 'nowplaying': {
                    const vcData = await getVoiceChannelForCommand(message);
                    const guildId = vcData?.guildId || message.guildId;
                    const player = rainlink.players.get(guildId);
                    if (!player?.queue?.current) return message.reply('❌ No music playing!');

                    const track = player.queue.current;
                    const duration = track.length > 0 ? track.length : await fetchYouTubeDuration(track.identifier);
                    const progress = Math.min(player.position, duration);

                    await message.reply(`
**🎶 Now Playing:** ${track.title}
\`[${createProgressBar(progress, duration)}]\` ${formatTime(progress)}${duration > 0 ? ` / ${formatTime(duration)}` : ''}
                    `);
                    break;
                }

                case 'queue': {
                    const vcData = await getVoiceChannelForCommand(message);
                    const guildId = vcData?.guildId || message.guildId;
                    const player = rainlink.players.get(guildId);
                    if (!player) return message.reply('❌ No music playing!');

                    const queueText = player.queue.map((t, i) => 
                        `${i + 1}. ${t.title} [${formatTime(t.length)}]`
                    ).join('\n');

                    await message.reply(`
**📜 Queue** (${player.queue.length})
${player.queue.current ? `Now: ${player.queue.current.title}\n\n` : ''}
${queueText || 'Queue is empty'}
                    `);
                    break;
                }

                case 'autoplay': {
                    const vcData = await getVoiceChannelForCommand(message);
                    const guildId = vcData?.guildId || message.guildId;
                    if (!guildId) {
                        return message.reply('❌ You need to be in a voice channel! Join a voice channel in any server first.');
                    }
                    const sub = args[0]?.toLowerCase();
                    if (sub === 'on') {
                        autoplayStatus.set(guildId, true);
                        await message.reply('🔁 Autoplay ENABLED');
                    } else if (sub === 'off') {
                        autoplayStatus.set(guildId, false);
                        await message.reply('🔁 Autoplay DISABLED');
                    } else {
                        const current = autoplayStatus.get(guildId) || false;
                        autoplayStatus.set(guildId, !current);
                        await message.reply(`🔁 Autoplay ${!current ? 'ENABLED' : 'DISABLED'}`);
                    }
                    break;
                }

                case 'loop': {
                    const vcData = await getVoiceChannelForCommand(message);
                    const guildId = vcData?.guildId || message.guildId;
                    if (!guildId) {
                        return message.reply('❌ You need to be in a voice channel! Join a voice channel in any server first.');
                    }
                    const sub = args.join(' ').toLowerCase();
                    if (sub === 'queue') {
                        loopType.set(guildId, 'queue');
                        await message.reply('🔄 Loop set to QUEUE');
                    } else if (sub === 'track') {
                        loopType.set(guildId, 'track');
                        await message.reply('🔄 Loop set to TRACK');
                    } else if (sub === 'off') {
                        loopType.set(guildId, 'off');
                        await message.reply('🔄 Loop DISABLED');
                    } else {
                        const current = loopType.get(guildId) || 'off';
                        await message.reply(`🔄 Current loop: ${current.toUpperCase()}`);
                    }
                    break;
                }

                case 'tts': {
                    const vcData = await getVoiceChannelForCommand(message);
                    const guildId = vcData?.guildId || message.guildId;
                    const sub = args[0]?.toLowerCase();
                    
                    if (sub === 'on') {
                        if (!vcData) {
                            return message.reply('❌ You need to be in a voice channel to enable TTS! Join a voice channel in any server first.');
                        }
                        ttsStatus.set(guildId, true);
                        await message.reply('🗣️ TTS ENABLED');
                        // Create player if not exists
                        let player = rainlink.players.get(guildId);
                        if (!player) {
                            player = await rainlink.create({
                                guildId: guildId,
                                textId: vcData.textChannel,
                                voiceId: vcData.voiceChannel.id,
                                shardId: 0,
                            });
                        }
                    } else if (sub === 'off') {
                        ttsStatus.set(guildId, false);
                        await message.reply('🗣️ TTS DISABLED');
                    } else {
                        // Speak the message
                        if (!guildId || !ttsStatus.get(guildId)) {
                            return message.reply('❌ TTS is not enabled! Use `tts on` first. (Make sure you are in a voice channel)');
                        }
                        const text = args.join(' ');
                        if (!text) return message.reply('❌ Please provide a message to speak!');

                        const player = rainlink.players.get(guildId);
                        if (!player) return message.reply('❌ No voice connection!');

                        try {
                            const url = gtts.getAudioUrl(text, { lang: 'en', slow: false });
                            const result = await player.search(url);
                            if (result?.tracks?.[0]) {
                                const wasPlaying = player.playing;
                                if (wasPlaying) await player.pause();
                                player.queue.unshift(result.tracks[0]);
                                await player.play();
                                // Estimate TTS duration (rough: 150 wpm, 5 chars per word)
                                const wordCount = text.split(' ').length;
                                const duration = Math.max(2000, wordCount * 400); // 400ms per word approx
                                setTimeout(async () => {
                                    if (wasPlaying) await player.resume();
                                }, duration);
                            }
                        } catch (err) {
                            console.error('TTS error:', err);
                            await message.reply('❌ Failed to generate TTS!');
                        }
                    }
                    break;
                }

                case 'volume': {
                    const vcData = await getVoiceChannelForCommand(message);
                    const guildId = vcData?.guildId || message.guildId;
                    const player = rainlink.players.get(guildId);
                    if (!player) return message.reply('❌ No music playing!');
                
                    const volArg = args[0];
                    if (!volArg) {
                        return message.reply(`🔊 Current Volume: ${player.volume}%`);
                    }
                
                    // Allow volume from 1% to 5000% (adjust max as needed)
                    const volNum = Math.max(1, Math.min(parseInt(volArg) || 100, 5000)); // Changed 500 → 5000
                    player.setVolume(volNum);
                    await message.reply(`🔊 Volume set to: **${volNum}%** (Max: 5000%)`);
                    break;
                }

                case 'lofi': {
                    const vcData = await getVoiceChannelForCommand(message);
                    const guildId = vcData?.guildId || message.guildId;
                    const player = rainlink.players.get(guildId);
                    if (!player) return message.reply('❌ No music playing!');
                
                    const sub = args[0]?.toLowerCase();
                    if (sub === 'off') {
                        // Remove filters
                        await player.setFilters({});
                        lofiStatus.set(guildId, false);
                        await message.reply('🎵 Lofi filter DISABLED');
                    } else {
                        // Apply lofi filters
                        await player.setFilters(filters.lofi);
                        lofiStatus.set(guildId, true);
                        await message.reply('🎵 Lofi filter ENABLED');
                    }
                    break;
                }

                case 'help': {
                    await message.reply(`
**🎵 Fynex Developments MUSIC SELFBOT COMMANDS**
\`${config.prefix}ping\` - Check if bot is online
\`${config.prefix}play <query>\` - Play a song/playlist (supports Spotify)
\`${config.prefix}pause\` - Pause/Resume song
\`${config.prefix}skip\` - Skip current song
\`${config.prefix}stop\` - Stop player
\`${config.prefix}nowplaying\` - Current track info
\`${config.prefix}queue\` - Show queue
\`${config.prefix}loop [queue|track|off]\` - Set loop mode
\`${config.prefix}autoplay [on|off]\` - Toggle autoplay
\`${config.prefix}tts [on|off|<message>]\` - TTS commands
\`${config.prefix}lofi\` - Toggle lofi filter
\`${config.prefix}volume [1-5000]\` - Set volume

💡 **Note:** All commands work in both DMs and servers! Just make sure you're in a voice channel in any server.
                    `);
                    break;
                }

                default:
                    await message.reply(`❌ Unknown command. Use \`${config.prefix}help\``);
            }
        } catch (error) {
            console.error('Command error:', error);
            await message.reply('❌ An error occurred!');
        }
    });

// Start the client
await client.login(token);
// Removed rpcClient.login since it's not needed
startGlobalMonitor(); // Remove this if you don't use it
}

// Initialize all tokens with better error handling
(async () => {
    try {
        await Promise.all(
            tokens.map(async (token) => {
                try {
                    await initClient(token);
                } catch (err) {
                    console.error(`[InitClient Error][Token ending ${token.slice(-5)}]`, err);
                }
            })
        );
    } catch (globalError) {
        console.error('[Global Init Error]', globalError);
    }
})();

