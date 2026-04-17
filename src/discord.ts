/**
 * Discord webhook (embed) message formatting for build notifications.
 *
 * @see https://discord.com/developers/docs/resources/webhook#execute-webhook
 */

import type { CloudflareEvent } from "./types";
import {
	getBuildStatus,
	isProductionBranch,
	extractAuthorName,
	getCommitUrl,
	getDashboardUrl,
	extractBuildError,
} from "./helpers";

// =============================================================================
// TYPES
// =============================================================================

export interface DiscordEmbedField {
	name: string;
	value: string;
	inline?: boolean;
}

export interface DiscordEmbed {
	title?: string;
	description?: string;
	url?: string;
	color?: number;
	fields?: DiscordEmbedField[];
}

export interface DiscordWebhookPayload {
	content?: string;
	embeds?: DiscordEmbed[];
}

// =============================================================================
// CONSTANTS
// =============================================================================

const COLOR_SUCCESS = 0x57f287;
const COLOR_FAILURE = 0xed4245;
const COLOR_WARNING = 0xfee75c;
const COLOR_NEUTRAL = 0x5865f2;
const DISCORD_DESCRIPTION_MAX = 4096;

// =============================================================================
// FIELD BUILDERS
// =============================================================================

function buildContextFields(event: CloudflareEvent): DiscordEmbedField[] {
	const meta = event.payload?.buildTriggerMetadata;
	const commitUrl = getCommitUrl(event);
	const fields: DiscordEmbedField[] = [];

	if (meta?.branch) {
		fields.push({
			name: "Branch",
			value: `\`${meta.branch}\``,
			inline: true,
		});
	}

	if (meta?.commitHash) {
		const short = meta.commitHash.substring(0, 7);
		const value = commitUrl ? `[${short}](${commitUrl})` : `\`${short}\``;
		fields.push({ name: "Commit", value, inline: true });
	}

	const authorName = extractAuthorName(meta?.author);
	if (authorName) {
		fields.push({ name: "Author", value: authorName, inline: true });
	}

	return fields;
}

function truncateDiscordDescription(text: string): string {
	if (text.length <= DISCORD_DESCRIPTION_MAX) return text;
	return text.slice(0, DISCORD_DESCRIPTION_MAX - 3) + "...";
}

// =============================================================================
// MESSAGE BUILDERS
// =============================================================================

function buildSuccessEmbed(
	event: CloudflareEvent,
	isProduction: boolean,
	previewUrl: string | null,
	liveUrl: string | null,
): DiscordEmbed {
	const workerName = event.source?.workerName || "Worker";
	const dashUrl = getDashboardUrl(event);

	const title = isProduction ? "Production Deploy" : "Preview Deploy";
	const linkLabel = isProduction
		? liveUrl
			? "View Worker"
			: "View Build"
		: previewUrl
			? "View Preview"
			: "View Build";
	const linkTarget = isProduction ? liveUrl || dashUrl : previewUrl || dashUrl;

	const lines = [`**${workerName}**`];
	if (linkTarget) {
		lines.push("", `[${linkLabel}](${linkTarget})`);
	}

	const fields = buildContextFields(event);

	return {
		title: `\u2705 ${title}`,
		url: linkTarget || undefined,
		description: truncateDiscordDescription(lines.join("\n")),
		color: COLOR_SUCCESS,
		...(fields.length > 0 ? { fields } : {}),
	};
}

function buildFailureEmbed(event: CloudflareEvent, logs: string[]): DiscordEmbed {
	const workerName = event.source?.workerName || "Worker";
	const dashUrl = getDashboardUrl(event);
	const error = extractBuildError(logs);

	const header = `**${workerName}**`;
	const logsLine = dashUrl ? `\n\n[View logs](${dashUrl})` : "";
	const codeOpen = "\n\n```\n";
	const codeClose = "\n```";
	const budget =
		DISCORD_DESCRIPTION_MAX -
		header.length -
		logsLine.length -
		codeOpen.length -
		codeClose.length;
	const body = error.length > budget ? error.slice(0, budget - 3) + "..." : error;
	const description = truncateDiscordDescription(
		header + logsLine + codeOpen + body + codeClose,
	);

	const fields = buildContextFields(event);

	return {
		title: "\u274c Build Failed",
		url: dashUrl || undefined,
		description,
		color: COLOR_FAILURE,
		...(fields.length > 0 ? { fields } : {}),
	};
}

function buildCancelledEmbed(event: CloudflareEvent): DiscordEmbed {
	const workerName = event.source?.workerName || "Worker";
	const dashUrl = getDashboardUrl(event);

	const lines = [`**${workerName}**`];
	if (dashUrl) {
		lines.push("", `[View build](${dashUrl})`);
	}

	const fields = buildContextFields(event);

	return {
		title: "\u26a0\ufe0f Build Cancelled",
		url: dashUrl || undefined,
		description: truncateDiscordDescription(lines.join("\n")),
		color: COLOR_WARNING,
		...(fields.length > 0 ? { fields } : {}),
	};
}

function buildFallbackEmbed(event: CloudflareEvent): DiscordEmbed {
	return {
		description: `\ud83d\udce2 ${event.type || "Unknown event"}`,
		color: COLOR_NEUTRAL,
	};
}

// =============================================================================
// MAIN EXPORTS
// =============================================================================

/**
 * Builds a Discord webhook JSON body for a build event.
 */
export function buildDiscordPayload(
	event: CloudflareEvent,
	previewUrl: string | null,
	liveUrl: string | null,
	logs: string[],
): DiscordWebhookPayload {
	const status = getBuildStatus(event);
	const meta = event.payload?.buildTriggerMetadata;
	const isProduction = isProductionBranch(meta?.branch);

	let embed: DiscordEmbed;
	if (status.isSucceeded) {
		embed = buildSuccessEmbed(event, isProduction, previewUrl, liveUrl);
	} else if (status.isFailed) {
		embed = buildFailureEmbed(event, logs);
	} else if (status.isCancelled) {
		embed = buildCancelledEmbed(event);
	} else {
		embed = buildFallbackEmbed(event);
	}

	return { embeds: [embed] };
}

/**
 * Sends a payload to a Discord webhook.
 */
export async function sendDiscordNotification(
	webhookUrl: string,
	payload: DiscordWebhookPayload,
): Promise<void> {
	const response = await fetch(webhookUrl, {
		method: "POST",
		headers: { "Content-Type": "application/json" },
		body: JSON.stringify(payload),
	});

	if (!response.ok) {
		console.error("Discord API error:", response.status, await response.text());
	}
}
