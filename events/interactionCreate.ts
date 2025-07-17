import type { Interaction, InteractionReplyOptions } from "discord.js";
import { clientCommands } from "../index.ts";
import { Events, MessageFlags } from "discord.js";

export const name = Events.InteractionCreate;
export async function execute(interaction: Interaction) {
    if (!interaction.isChatInputCommand()) return;
    const command = clientCommands.get(interaction.commandName);
    if (!command) {
        console.error(`No command matching ${interaction.commandName} was found.`);
        return;
    }

    try {
        await command.execute(interaction);
    } catch (error) {
        console.error(error);

        const replyData = { content: "There was an error while executing this command!", flags: MessageFlags.Ephemeral } as InteractionReplyOptions;
        if (interaction.replied || interaction.deferred) await interaction.followUp(replyData);
        else await interaction.reply(replyData);
    }
}