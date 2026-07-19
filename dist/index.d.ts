interface PluginLogger {
    info?: (message: string) => void;
    warn?: (message: string) => void;
}
type PluginConfigParseResult = {
    success: true;
    data: unknown;
} | {
    success: false;
    error: {
        message: string;
    };
};
interface OpenClawPluginConfigSchema {
    safeParse: (value: unknown) => PluginConfigParseResult;
    jsonSchema: {
        type: 'object';
        additionalProperties: boolean;
        properties?: Record<string, never>;
    };
}
interface PluginToolDefinition {
    name: string;
    label: string;
    description: string;
    parameters: unknown;
    execute: (toolCallId: string, params: unknown) => unknown;
}
interface OpenClawPluginApi {
    pluginConfig?: unknown;
    logger?: PluginLogger;
    registerMemoryCapability?: (capability: {
        promptBuilder: (input: {
            availableTools: Set<string>;
        }) => string[];
    }) => void;
    registerTool: (tool: PluginToolDefinition, options?: {
        name?: string;
    }) => void;
    on: {
        (event: 'before_prompt_build', handler: (event: {
            prompt?: string;
            messages?: unknown[];
        }) => Promise<{
            prependContext: string;
        } | undefined> | {
            prependContext: string;
        } | undefined, options?: {
            timeoutMs?: number;
        }): void;
        (event: 'agent_end', handler: (event: {
            success?: boolean;
            runId?: string;
            messages?: unknown[];
        }, context?: {
            sessionKey?: string;
            sessionId?: string;
        }) => void, options?: {
            timeoutMs?: number;
        }): void;
    };
}
interface OpenClawPluginDefinition {
    id: string;
    name: string;
    description: string;
    configSchema: OpenClawPluginConfigSchema;
    register: (api: OpenClawPluginApi) => void;
}
declare const plugin: OpenClawPluginDefinition;
export default plugin;
