import { Client, Events } from "discord.js";

export const name = Events.ClientReady;
export const once = true;
export function execute(client: Client) {
    if (!client.user) {
        console.error("Client user is not defined (bot probably failed to log in).");
        process.exit(1);
    }

    console.log(`Ready! Logged in as ${client.user.tag}`);
}