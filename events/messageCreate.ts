import { Events, Guild, GuildMember, Message, TextChannel, Attachment } from "discord.js";
import OpenAI from "openai";
import { readFileSync, writeFileSync, existsSync, mkdirSync } from "fs";
import { join } from "path";
import type { ChatCompletion } from "openai/resources";
import { configManager } from "../config";

const client = new OpenAI({
    apiKey: Bun.env.API_KEY,
    baseURL: "https://api.x.ai/v1",
});

interface BotResponse {
    reply: string;
    memory: string;
    should_generate_image: boolean;
}

interface ImageDescription {
    url: string;
    description: string;
    messageContext: string;
    author: string;
    isFromCurrentUser: boolean;
}

const responseSchema = {
    type: "object",
    properties: {
        reply: {
            type: "string",
            description: "The bot's response to the user's message. Leave empty if generating an image."
        },
        memory: {
            type: "string",
            description: "Personal information about the user to remember for future conversations. Include things like their name, interests, preferences, important life events, or context that would help personalize future interactions. If there's nothing meaningful to remember or if generating an image, use an empty string."
        },
        should_generate_image: {
            type: "boolean",
            description: "Whether to generate an image based on the user's request. Set to true if the user is asking for an image, artwork, picture, or visual content. Do not try to guess if the user wants an image; only set this to true if the user EXPLICLITLY asks for it - IGNORE message context. If generating an image, leave the reply empty. But if the user has an active image ratelimit, set this to false and provide a reason in the reply, using your writing style. If the user is not asking for an image, set this to false and provide a reply in the reply field from the system prompt."
        }
    },
    required: ["reply", "memory", "should_generate_image"],
    additionalProperties: false
};

type QueuedMessage = {
    message: Message;
    member: GuildMember;
    meta: {
        guild: Guild;
        channel: TextChannel;
        members: GuildMember[];
        recentMessages: { username: string; content: string; attachments: Attachment[] }[];
        imageDescriptions: ImageDescription[];
    };
    prompt_settings: {
        system_prompt: string;
    };
    timestamp: number;
};

const messageQueue: QueuedMessage[] = [];
const MAX_MESSAGES_PER_SECOND = 8;
const USER_COOLDOWN_MS = 2500;
const userLastMessageTime = new Map<string, number>();

const MEMORY_DIR = "memory";
const RATELIMIT_DIR = "ratelimits";

if (!existsSync(MEMORY_DIR)) {
    mkdirSync(MEMORY_DIR, { recursive: true });
}

if (!existsSync(RATELIMIT_DIR)) {
    mkdirSync(RATELIMIT_DIR, { recursive: true });
}

function loadUserMemory(userId: string): string {
    const memoryPath = join(MEMORY_DIR, `${userId}.txt`);
    if (existsSync(memoryPath)) {
        try {
            return readFileSync(memoryPath, "utf8");
        } catch (error) {
            console.error(`Error loading memory for user ${userId}:`, error);
            return "";
        }
    }
    return "";
}

function saveUserMemory(userId: string, memoryContent: string): void {
    const memoryPath = join(MEMORY_DIR, `${userId}.txt`);
    try {
        writeFileSync(memoryPath, memoryContent, "utf8");
    } catch (error) {
        console.error(`Error saving memory for user ${userId}:`, error);
    }
}

function updateUserMemory(userId: string, newMemory: string): void {
    if (!newMemory.trim()) return;

    const existingMemory = loadUserMemory(userId);
    let updatedMemory = existingMemory;

    if (existingMemory) updatedMemory = `${existingMemory}\n- ${newMemory}`;
    else updatedMemory = newMemory;

    saveUserMemory(userId, updatedMemory);
}

function getTodayString(): string {
    return new Date().toISOString().split("T")[0] + "T00:00:00Z";
}

function loadUserImageCount(userId: string): number {
    const rateLimitPath = join(RATELIMIT_DIR, `user_${userId}.json`);
    if (existsSync(rateLimitPath)) {
        try {
            const data = JSON.parse(readFileSync(rateLimitPath, "utf8"));
            if (data.date === getTodayString()) {
                return data.count;
            }
        } catch (error) {
            console.error(`Error loading user image count for ${userId}:`, error);
        }
    }
    return 0;
}

function saveUserImageCount(userId: string, count: number): void {
    const rateLimitPath = join(RATELIMIT_DIR, `user_${userId}.json`);
    try {
        const data = {
            date: getTodayString(),
            count: count
        };
        writeFileSync(rateLimitPath, JSON.stringify(data), "utf8");
    } catch (error) {
        console.error(`Error saving user image count for ${userId}:`, error);
    }
}

function loadGuildImageCount(guildId: string): number {
    const rateLimitPath = join(RATELIMIT_DIR, `guild_${guildId}.json`);
    if (existsSync(rateLimitPath)) {
        try {
            const data = JSON.parse(readFileSync(rateLimitPath, "utf8"));
            if (data.date === getTodayString()) {
                return data.count;
            }
        } catch (error) {
            console.error(`Error loading guild image count for ${guildId}:`, error);
        }
    }
    return 0;
}

function saveGuildImageCount(guildId: string, count: number): void {
    const rateLimitPath = join(RATELIMIT_DIR, `guild_${guildId}.json`);
    try {
        const data = {
            date: getTodayString(),
            count: count
        };
        writeFileSync(rateLimitPath, JSON.stringify(data), "utf8");
    } catch (error) {
        console.error(`Error saving guild image count for ${guildId}:`, error);
    }
}

function checkImageRateLimit(userId: string, guildId: string): { canGenerate: boolean; reason?: string } {
    const userCount = loadUserImageCount(userId);
    const guildCount = loadGuildImageCount(guildId);

    if (userCount >= 1/*&& userId !== "434417514332815370"*/) {
        return { canGenerate: false, reason: "You have reached your daily image generation limit (1 per day)." };
    }

    if (guildCount >= 10/*&& userId !== "434417514332815370"*/) {
        return { canGenerate: false, reason: "This server has reached its daily image generation limit (10 per day)." };
    }

    return { canGenerate: true };
}

function incrementImageCounts(userId: string, guildId: string): void {
    const userCount = loadUserImageCount(userId);
    const guildCount = loadGuildImageCount(guildId);

    saveUserImageCount(userId, userCount + 1);
    saveGuildImageCount(guildId, guildCount + 1);
}

function decrementImageCounts(userId: string, guildId: string): void {
    const userCount = loadUserImageCount(userId);
    const guildCount = loadGuildImageCount(guildId);

    saveUserImageCount(userId, Math.max(0, userCount - 1));
    saveGuildImageCount(guildId, Math.max(0, guildCount - 1));
}

async function generateImage(prompt: string): Promise<string | null> {
    try {
        const response = await client.images.generate({
            model: "grok-2-image",
            prompt: prompt,
            n: 1,
            response_format: "url"
        });

        if (response.data && response.data.length > 0 && response.data[0]?.url) {
            return response.data[0].url;
        }

        return null;
    } catch (error) {
        console.error("Error generating image:", error);
        return null;
    }
}

async function analyzeImageWithVision(imageUrl: string, messageContext: string): Promise<string> {
    try {
        const completion = await client.chat.completions.create({
            model: "grok-2-vision-1212",
            messages: [
                {
                    role: "user",
                    content: [
                        {
                            type: "image_url",
                            image_url: {
                                url: imageUrl,
                                detail: "high"
                            }
                        },
                        {
                            type: "text",
                            text: `Analyze this image in the context of this Discord message: "${messageContext}". Provide a detailed description of what you see in the image, including any relevant objects, people, text, emotions, or activities. Keep the description concise but informative, focusing on elements that would be useful for understanding the conversation context.`
                        }
                    ]
                }
            ]
        });

        return completion.choices?.[0]?.message?.content || "Unable to analyze image";
    } catch (error) {
        console.error("Error analyzing image with vision:", error);
        return "Error analyzing image";
    }
}

async function processImagesFromMessages(
    messages: { username: string; content: string; attachments: Attachment[] }[],
    currentUserId: string
): Promise<ImageDescription[]> {
    const imageDescriptions: ImageDescription[] = [];
    let processedCount = 0;

    for (let i = messages.length - 1; i >= 0 && processedCount < 5; i--) {
        const msg = messages[i];
        if (!msg) continue;
        const imageAttachments = msg.attachments.filter(att =>
            att.contentType?.startsWith("image/") &&
            (att.contentType === "image/jpeg" || att.contentType === "image/png")
        );

        for (const attachment of imageAttachments) {
            if (processedCount >= 5) break;

            try {
                const description = await analyzeImageWithVision(attachment.url, msg.content);
                imageDescriptions.push({
                    url: attachment.url,
                    description,
                    messageContext: msg.content,
                    author: msg.username,
                    isFromCurrentUser: msg.username === currentUserId
                });
                processedCount++;
            } catch (error) {
                console.error(`Error processing image from ${msg.username}:`, error);
            }
        }
    }

    return imageDescriptions;
}

setInterval(processQueue, 1000 / MAX_MESSAGES_PER_SECOND);

async function processQueue() {
    if (messageQueue.length === 0) return;

    const queuedMessage = messageQueue.shift()!;
    queuedMessage.meta.channel.sendTyping();

    try {
        await handleAIResponse(queuedMessage);
    } catch (error) {
        console.error("Error processing queued message:", error);
        queuedMessage.message.reply("Sorry, there was an error processing your request. Please try again later.");
    }
}

async function handleAIResponse(msg: QueuedMessage) {
    const userId = msg.message.author.id;
    const guildId = msg.meta.guild.id;
    const userMemory = loadUserMemory(userId);

    let enhancedSystemPrompt = "";
    enhancedSystemPrompt += "You are a Discord bot that provides personalized responses based on user context, optional memory, recent interactions and chosen system style.\n";
    enhancedSystemPrompt += "The following section contains the system prompt which defines your behavior and personality.\n";
    enhancedSystemPrompt += `It may or may not be written in another language than English. Whatever language it is, you must understand it and respond in the SAME language.\n`;
    enhancedSystemPrompt += `Even if the user writes in another language or the previous context/messages are in another language, you must always respond in the language of the system prompt.\n\n`;

    enhancedSystemPrompt += `# System Prompt:\n`;
    enhancedSystemPrompt += `-- Start System Prompt ---\n`;
    enhancedSystemPrompt += msg.prompt_settings.system_prompt;
    enhancedSystemPrompt += `\n--- End System Prompt ---\n\n`;

    enhancedSystemPrompt += `IMPORTANT! Below, you"ll find some information about the user and the current context. Use this to generate a personalized response.\n`;
    enhancedSystemPrompt += `# Environment Information:\n`;
    enhancedSystemPrompt += `## User Information:\n`;
    enhancedSystemPrompt += `User ID: ${userId}\n`;
    enhancedSystemPrompt += `Username: ${msg.message.author.username}\n`;
    enhancedSystemPrompt += `Display Name: ${msg.message.author.displayName}\n`;
    enhancedSystemPrompt += `Nickname: ${msg.member.nickname || "None"}\n\n`;
    enhancedSystemPrompt += `Image Rate Limit: ${loadUserImageCount(userId)}/1 (daily) -> IS ALLOWED TO GENERATE IMAGE? ${checkImageRateLimit(userId, guildId).canGenerate ? "YES" : "NO"}\n\n`;

    enhancedSystemPrompt += `## Channel Information:\n`;
    enhancedSystemPrompt += `Channel ID: ${msg.meta.channel.id}\n`;
    enhancedSystemPrompt += `Channel Name: ${msg.meta.channel.name}\n\n`;

    enhancedSystemPrompt += `## Guild Information:\n`;
    enhancedSystemPrompt += `Guild ID: ${msg.meta.guild.id}\n`;
    enhancedSystemPrompt += `Guild Name: ${msg.meta.guild.name}\n`;
    enhancedSystemPrompt += `Guild Member Count: ${msg.meta.guild.memberCount}\n\n`;

    enhancedSystemPrompt += `## Current Time:\n`;
    enhancedSystemPrompt += `${new Date().toLocaleString()}\n\n`;

    enhancedSystemPrompt += `## Members in Channel:\n`;
    enhancedSystemPrompt += (msg.meta.members.map(m => `${m.user.username} (${m.id})`).join(", ") || "No members found") + "\n\n";

    enhancedSystemPrompt += `## User Memory:\n`;
    enhancedSystemPrompt += `${userMemory ? `--- Start User Memory ---\n${userMemory}\n--- End User Memory ---` : ""}\n\n`;

    if (msg.meta.imageDescriptions.length > 0) {
        enhancedSystemPrompt += `## Recent Images in Conversation:\n`;
        enhancedSystemPrompt += `The following images were shared in recent messages (most recent first, max 5 images):\n\n`;

        const sortedImages = msg.meta.imageDescriptions.sort((a, b) => {
            if (a.isFromCurrentUser && !b.isFromCurrentUser) return -1;
            if (!a.isFromCurrentUser && b.isFromCurrentUser) return 1;
            return 0;
        });

        sortedImages.forEach((img, index) => {
            const priority = img.isFromCurrentUser ? "[HIGH PRIORITY - Current User's Image]" : "[Context Image]";
            enhancedSystemPrompt += `### Image ${index + 1} ${priority}\n`;
            enhancedSystemPrompt += `**Author:** ${img.author}\n`;
            enhancedSystemPrompt += `**Message Context:** ${img.messageContext || "No message text"}\n`;
            enhancedSystemPrompt += `**Image Description:** ${img.description}\n`;
            enhancedSystemPrompt += `**Image URL:** ${img.url}\n\n`;
        });
    }

    enhancedSystemPrompt += "## Recent messages:\n";
    enhancedSystemPrompt += `${msg.meta.recentMessages.map(m => `${m.username}: ${m.content}`).join("\n")}\n\n`;

    enhancedSystemPrompt += "## Current message (the one you're replying to):\n";
    enhancedSystemPrompt += `${msg.message.author.username}: ${msg.message.content}\n\n`;

    const currentMessageImages = msg.message.attachments.filter(att =>
        att.contentType?.startsWith("image/") &&
        (att.contentType === "image/jpeg" || att.contentType === "image/png")
    );

    if (currentMessageImages.size > 0) {
        enhancedSystemPrompt += "## Current Message Images:\n";
        enhancedSystemPrompt += `The user has attached ${currentMessageImages.size} image(s) to their current message. These images should be given HIGH PRIORITY in your response as they are directly relevant to the current conversation.\n\n`;
    }

    enhancedSystemPrompt += "## Output rules:\n";
    enhancedSystemPrompt += readFileSync("prompts/structured_outputs/memory.txt", "utf8");

    const completion: ChatCompletion = await client.chat.completions.create({
        model: "grok-3-mini",
        messages: [
            { role: "system", content: enhancedSystemPrompt },
            { role: "user", content: msg.message.content }
        ],
        response_format: {
            type: "json_schema",
            json_schema: {
                name: "bot_response",
                strict: true,
                schema: responseSchema
            }
        }
    });

    const responseContent = completion.choices?.[0]?.message?.content;
    if (!responseContent) {
        msg.message.reply("Sorry, I couldn't generate a response. Please try again later.");
        return;
    }

    try {
        const parsedResponse: BotResponse = JSON.parse(responseContent);

        if (parsedResponse.should_generate_image) {
            const rateLimitCheck = checkImageRateLimit(userId, guildId);

            if (!rateLimitCheck.canGenerate) {
                msg.message.reply(`🚫 ${rateLimitCheck.reason}`);
                return;
            }

            incrementImageCounts(userId, guildId);
            await msg.message.react("🖼️");
            await msg.message.react("⏳");
            const imageUrl = await generateImage(msg.message.content);
            if (imageUrl) {
                await msg.message.reply({
                    content: "",
                    files: [imageUrl]
                });
                console.log(`=============================================`);
                console.log(`[${new Date().toLocaleTimeString()}] - {${msg.meta.guild.name}} > ${msg.meta.channel.name} > ${msg.message.author.username}: ${msg.message.content}`);
                console.log(`[${new Date().toLocaleTimeString()}] - {${msg.meta.guild.name}} > ${msg.meta.channel.name} > Grok: Generated image`);
                console.log(`=============================================`);
            } else {
                decrementImageCounts(userId, guildId);
                msg.message.reply("Sorry, I couldn't generate an image right now. Please try again later.");
            }
        } else {
            if (parsedResponse.memory && parsedResponse.memory.trim()) {
                updateUserMemory(userId, parsedResponse.memory);
                console.log(`Updated memory for user ${msg.message.author.username}: ${parsedResponse.memory}`);
            }

            const blackList = ["@everyone", "@here", "<@", "nigg", "nega", "niga"];
            if (blackList.some(term => parsedResponse.reply.toLowerCase().replaceAll(" ", "").replaceAll(",", "").includes(term))) {
                msg.message.reply("nice try");
                return;
            }

            msg.message.reply(parsedResponse.reply);
            console.log(`=============================================`);
            console.log(`[${new Date().toLocaleTimeString()}] - {${msg.meta.guild.name}} > ${msg.meta.channel.name} > ${msg.message.author.username}: ${msg.message.content}`);
            console.log(`[${new Date().toLocaleTimeString()}] - {${msg.meta.guild.name}} > ${msg.meta.channel.name} > Grok: ${parsedResponse.reply}`);
            console.log(`=============================================`);
        }
    } catch (parseError) {
        console.error("Error parsing structured response:", parseError);
        console.error("Raw response:", responseContent);
        msg.message.reply("Sorry, I had trouble processing that request. Please try again.");
    }
}

export const name = Events.MessageCreate;
export async function execute(message: Message) {
    if (message.author.bot || !message.guild || !message.content) return;

    const guildConfig = await configManager.getConfig(message.guild.id);
    if (guildConfig && guildConfig.channelId !== null && guildConfig.channelId !== message.channel.id) return;

    const currentTime = Date.now();
    const lastMessageTime = userLastMessageTime.get(message.author.id);
    if (lastMessageTime && currentTime - lastMessageTime < USER_COOLDOWN_MS) {
        const remainingTime = Math.ceil((USER_COOLDOWN_MS - (currentTime - lastMessageTime)) / 1000);
        message.reply(`⏳ Please wait ${remainingTime} second(s) before sending another message.`);
        return;
    }

    userLastMessageTime.set(message.author.id, currentTime);

    const recentMessages = await getRecentMessageHistory(message.channel as TextChannel, 15);
    const imageDescriptions = await processImagesFromMessages(recentMessages, message.author.username);

    messageQueue.push({
        message,
        member: message.member as GuildMember,
        meta: {
            guild: message.guild as Guild,
            channel: message.channel as TextChannel,
            members: await getMemberListFromChannel(message.channel as TextChannel),
            recentMessages,
            imageDescriptions
        },
        prompt_settings: {
            system_prompt: parsePrompt(`prompts/personality/${guildConfig.personality}.txt`),
        },
        timestamp: currentTime,
    });

    if (messageQueue.length > 5) {
        message.react("⏳");
    }
}

function parsePrompt(promptFile: string): string {
    const content = readFileSync(promptFile, "utf8").split("# CONTENT:\n")[1];
    return content ? content.trim() : "";
}

async function getMemberListFromChannel(channel: TextChannel): Promise<GuildMember[]> {
    return channel.guild.members.fetch()
        .then(members => Array.from(members.values()))
        .catch(error => {
            console.error("Error fetching channel members:", error);
            return [];
        });
}

async function getRecentMessageHistory(channel: TextChannel, limit: number = 5): Promise<{ username: string, content: string, attachments: Attachment[] }[]> {
    return channel.messages.fetch({ limit })
        .then((messages) => {
            const messageArray = Array.from(messages.values()).reverse();
            const messageHistory: { username: string, content: string, attachments: Attachment[] }[] = [];
            messageArray.forEach((msg: Message) => {
                const content = msg.content;
                const attachments = Array.from(msg.attachments.values());
                messageHistory.push({ username: msg.author.username, content, attachments });
            });

            return messageHistory;
        })
        .catch(error => {
            console.error("Error fetching recent messages:", error);
            return [];
        });
}