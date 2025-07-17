import type { ChatInputCommandInteraction } from "discord.js";
import { SlashCommandBuilder, InteractionContextType } from "discord.js";
import { configManager } from "../../config";
import { readdir, readFile } from "fs/promises";
import { join } from "path";

async function loadPersonalities(): Promise<{ name: string; value: string }[]> {
    try {
        const promptsDir = join(process.cwd(), "prompts", "personality");
        const files = await readdir(promptsDir);
        const txtFiles = files.filter(file => file.endsWith(".txt"));

        const personalities: { name: string; value: string }[] = [];

        for (const file of txtFiles) {
            const filePath = join(promptsDir, file);
            const content = await readFile(filePath, "utf-8");

            const lines = content.split("\n");
            const nameIndex = lines.findIndex(line => line.trim() === "# NAME");

            if (nameIndex !== -1 && nameIndex + 1 < lines.length && typeof lines[nameIndex + 1] === "string") {
                const name = lines[nameIndex + 1]?.trim() ?? "";
                const value = file.replace(".txt", "");
                personalities.push({ name, value });
            }
        }

        return personalities;
    } catch (error) {
        console.error("Error loading personalities:", error);
        return [];
    }
}

async function createCommandData() {
    const personalities = await loadPersonalities();

    return new SlashCommandBuilder()
        .setName("personality")
        .setDescription("Set the personality for the bot")
        .setContexts(InteractionContextType.PrivateChannel, InteractionContextType.BotDM, InteractionContextType.Guild)
        .addStringOption(option =>
            option.setName("personality")
                .setDescription("The personality to set for the bot")
                .setRequired(true)
                .addChoices(...personalities.map(p => ({ name: p.name, value: p.value })))
        );
}

export const data = await createCommandData();

export async function execute(interaction: ChatInputCommandInteraction) {
    const personality = interaction.options.getString("personality", true);
    await interaction.deferReply();

    try {
        const guildId = interaction.guildId;
        if (!guildId) {
            await interaction.editReply("This command can only be used in a server!");
            return;
        }

        let eligible = interaction.user.id === "434417514332815370" ? true : interaction.memberPermissions?.has("ManageChannels");
        if (!eligible) {
            await interaction.editReply("You need the `Manage Channels` permission to use this command!");
            return;
        }

        const personalities = await loadPersonalities();
        const selectedPersonality = personalities.find(p => p.value === personality);

        if (!selectedPersonality) {
            await interaction.editReply("❌ Invalid personality selected!");
            return;
        }

        await configManager.updateConfig(guildId, {
            personality: personality
        });

        await interaction.editReply(`✅ Bot personality has been set to **${selectedPersonality.name}**!`);
    } catch (error) {
        console.error("Error setting personality:", error);
        await interaction.editReply("❌ An error occurred while setting the personality. Please try again.");
    }
}