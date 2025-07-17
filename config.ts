import { promises as fs } from "fs";
import path from "path";

interface GuildConfig {
    channelId: string | null;
    personality: string;
}

class ConfigManager {
    private configDir: string;
    private configCache: Map<string, GuildConfig> = new Map();

    constructor(configDir: string = "./config") {
        this.configDir = configDir;
    }

    async init(): Promise<void> {
        try {
            await fs.access(this.configDir);
        } catch {
            await fs.mkdir(this.configDir, { recursive: true });
        }
    }

    private getConfigPath(guildId: string): string {
        return path.join(this.configDir, `${guildId}.json`);
    }

    async getConfig(guildId: string): Promise<GuildConfig> {
        if (this.configCache.has(guildId)) {
            return this.configCache.get(guildId)!;
        }

        const configPath = this.getConfigPath(guildId);

        try {
            const data = await fs.readFile(configPath, "utf8");
            const config: GuildConfig = JSON.parse(data);

            this.configCache.set(guildId, config);

            return config;
        } catch (error) {
            const defaultConfig: GuildConfig = {
                channelId: null,
                personality: "gork_english"
            };

            this.configCache.set(guildId, defaultConfig);
            await this.saveConfig(guildId, defaultConfig);

            return defaultConfig;
        }
    }

    async saveConfig(guildId: string, config: GuildConfig): Promise<void> {
        const configPath = this.getConfigPath(guildId);

        try {
            await fs.writeFile(configPath, JSON.stringify(config, null, 2), "utf8");
            this.configCache.set(guildId, config);
        } catch (error) {
            console.error(`Failed to save config for guild ${guildId}:`, error);
            throw error;
        }
    }

    async updateConfig(guildId: string, updates: Partial<GuildConfig>): Promise<GuildConfig> {
        const currentConfig = await this.getConfig(guildId);
        const updatedConfig = { ...currentConfig, ...updates };

        await this.saveConfig(guildId, updatedConfig);
        return updatedConfig;
    }

    async deleteConfig(guildId: string): Promise<void> {
        const configPath = this.getConfigPath(guildId);

        try {
            await fs.unlink(configPath);
            this.configCache.delete(guildId);
        } catch (error) {
            console.warn(`Config file for guild ${guildId} not found for deletion`);
        }
    }

    async getConfigValue<T>(guildId: string, key: keyof GuildConfig): Promise<T | undefined> {
        const config = await this.getConfig(guildId);
        return config[key] as T;
    }

    async setConfigValue(guildId: string, key: keyof GuildConfig, value: any): Promise<void> {
        await this.updateConfig(guildId, { [key]: value });
    }

    async hasConfig(guildId: string): Promise<boolean> {
        const configPath = this.getConfigPath(guildId);

        try {
            await fs.access(configPath);
            return true;
        } catch {
            return false;
        }
    }

    async getAllGuildIds(): Promise<string[]> {
        try {
            const files = await fs.readdir(this.configDir);
            return files
                .filter(file => file.endsWith(".json"))
                .map(file => path.basename(file, ".json"));
        } catch {
            return [];
        }
    }

    clearCache(): void {
        this.configCache.clear();
    }

    async reloadConfig(guildId: string): Promise<GuildConfig> {
        this.configCache.delete(guildId);
        return await this.getConfig(guildId);
    }
}

export const configManager = new ConfigManager();
export type { GuildConfig };