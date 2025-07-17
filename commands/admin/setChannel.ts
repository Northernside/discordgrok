import type { ChatInputCommandInteraction } from "discord.js";
import { SlashCommandBuilder, InteractionContextType, ChannelType } from "discord.js";
import { configManager } from "../../config";

export const data = new SlashCommandBuilder()
    .setName("channel")
    .setDescription("Set the channel for the bot to operate in")
    .setContexts(InteractionContextType.PrivateChannel, InteractionContextType.BotDM, InteractionContextType.Guild)
    .addChannelOption(option =>
        option.setName("channel")
            .setDescription("The channel to set for the bot to operate in")
            .setRequired(true)
            .addChannelTypes(ChannelType.GuildText)
    );

export async function execute(interaction: ChatInputCommandInteraction) {
    const channel = interaction.options.getChannel("channel", true);
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

        await configManager.updateConfig(guildId, {
            channelId: channel.id
        });

        await interaction.editReply(`✅ Bot channel has been set to ${channel}!`);
    } catch (error) {
        console.error("Error setting channel:", error);
        await interaction.editReply("❌ An error occurred while setting the channel. Please try again.");
    }
}
