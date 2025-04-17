require('dotenv').config();
const { Client, GatewayIntentBits, REST, Routes, SlashCommandBuilder } = require('discord.js');
const OpenAI = require('openai');

// Discord Client Setup
const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent
  ]
});

// OpenAI Setup
const openai = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY
});

// Memory and Usage Tracking
const userMemory = new Map();
const userUsageMap = new Map();
const rateLimitMap = new Map();

// Constants
const MAX_MEMORY = 6;
const MAX_USAGE = 10;
const RATE_LIMIT = 3;
const RATE_WINDOW = 5 * 60 * 1000; // 5 minutes

// Register Slash Commands
client.once('ready', async () => {
  const commands = [
    new SlashCommandBuilder()
      .setName('reset')
      .setDescription('Reset your own conversation history and usage count'),

    new SlashCommandBuilder()
      .setName('admin-reset')
      .setDescription('Reset another user\'s session')
      .addUserOption(option =>
        option.setName('target')
          .setDescription('User to reset')
          .setRequired(true)
      ),

    new SlashCommandBuilder()
      .setName('stats')
      .setDescription('View your current usage stats')
  ].map(cmd => cmd.toJSON());

  const rest = new REST({ version: '10' }).setToken(process.env.DISCORD_TOKEN);

  try {
    await rest.put(Routes.applicationCommands(client.user.id), { body: commands });
    console.log('✅ Slash commands registered');
  } catch (err) {
    console.error('❌ Error registering commands:', err);
  }

  console.log(`🤖 Logged in as ${client.user.tag}`);
});

const channelMemory = new Map(); // 🧠 Shared Memory per Channel

// Respond to @mention
client.on('messageCreate', async (message) => {
  if (message.author.bot) return;

  const channelId = message.channel.id;
  const username = message.author.username;
  const content = message.content.trim();
  const memory = channelMemory.get(channelId) || [];

  memory.push({ role: 'user', content: `${username} says: ${content}` });
  if (memory.length > MAX_MEMORY) memory.shift();
  channelMemory.set(channelId, memory);

  if (!message.mentions.has(client.user)) return;

  // Rate Limiting per User
  const userId = message.author.id;
  const now = Date.now();
  const timestamps = rateLimitMap.get(userId) || [];
  const recent = timestamps.filter(t => now - t < RATE_WINDOW);
  if (recent.length >= RATE_LIMIT) {
    return message.reply('⏳ You’re asking too fast. Please wait a few minutes.');
  }
  timestamps.push(now);
  rateLimitMap.set(userId, timestamps);

  // Usage Limits
  const usageCount = userUsageMap.get(userId) || 0;
  if (usageCount >= MAX_USAGE) {
    return message.reply(`❌ You've reached your session limit of ${MAX_USAGE} messages.`);
  }
  userUsageMap.set(userId, usageCount + 1);

  // Add Typing Indicator
  await message.channel.sendTyping();

  // Add System Prompt + Context
  const chatHistory = [
    {
      role: 'system',
      content: `You are Zavala, an intelligent and friendly assistant in a Discord channel. You're aware of conversations between multiple users. Reply only when directly mentioned. Use their names to keep things clear.`
    },
    ...memory
  ];

  try {
    const response = await openai.chat.completions.create({
      model: 'gpt-4o',
      messages: chatHistory,
      max_tokens: 150,
      temperature: 0.9
    });

    const botReply = response.choices[0].message.content;

    // Save Bot's Response into Channel Memory
    memory.push({ role: 'assistant', content: botReply });
    if (memory.length > MAX_MEMORY) memory.shift();
    channelMemory.set(channelId, memory);

    await message.reply(botReply);
  } catch (err) {
    console.error('OpenAI error:', err);
    await message.reply('❌ Error talking to OpenAI.');
  }
});

// Slash Command Handlers
client.on('interactionCreate', async (interaction) => {
  if (!interaction.isChatInputCommand()) return;

  const userId = interaction.user.id;

  if (interaction.commandName === 'admin-reset') {
    const member = await interaction.guild.members.fetch(userId);
    if (!member.permissions.has('Administrator')) {
      return interaction.reply({
        content: '❌ You do not have permission to use this command.',
        ephemeral: true
      });
    }

    const target = interaction.options.getUser('target');
    userMemory.delete(target.id);
    userUsageMap.delete(target.id);
    rateLimitMap.delete(target.id);

    await interaction.reply({
      content: `✅ Reset session for <@${target.id}>.`,
      ephemeral: true
    });
  }

  if (interaction.commandName === 'reset') {
    userMemory.delete(userId);
    userUsageMap.delete(userId);
    rateLimitMap.delete(userId);

    await interaction.reply({
      content: '✅ Your session has been reset.',
      ephemeral: true
    });
  }

  if (interaction.commandName === 'stats') {
    const usage = userUsageMap.get(userId) || 0;
    const memory = userMemory.get(userId) || [];
    const recent = rateLimitMap.get(userId)?.filter(t => Date.now() - t < RATE_WINDOW).length || 0;

    await interaction.reply({
      content: `**Your Stats:**\n- Usage Count: ${usage}/${MAX_USAGE}\n- Memory Entries: ${memory.length}/${MAX_MEMORY}\n- Recent Requests: ${recent}/${RATE_LIMIT}`,
      ephemeral: true
    });
  }
});

client.login(process.env.DISCORD_TOKEN);