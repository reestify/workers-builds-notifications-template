/**
 * Cloudflare Workers Builds → Discord Notifications
 *
 * This worker consumes build events from a Cloudflare Queue and sends
 * notifications to Discord with:
 * - Preview/Live URLs for successful builds
 * - Error messages for failed builds
 * - Cancellation notices for cancelled builds
 *
 * @see https://developers.cloudflare.com/workers/ci-cd/builds
 * @see https://developers.cloudflare.com/queues/
 * @see https://developers.cloudflare.com/queues/event-subscriptions/
 */

import type { Env, CloudflareEvent } from "./types";
import { getBuildStatus } from "./helpers";
import { fetchBuildUrls, fetchBuildLogs } from "./api";
import { buildDiscordPayload, sendDiscordNotification } from "./discord";

export default {
	async queue(batch: MessageBatch<CloudflareEvent>, env: Env): Promise<void> {
		if (!env.DISCORD_WEBHOOK_URL) {
			console.error("DISCORD_WEBHOOK_URL is not configured");
			for (const message of batch.messages) {
				message.ack();
			}
			return;
		}

		for (const message of batch.messages) {
			try {
				const event = message.body;

				// Validate event structure
				if (!event?.type || !event?.payload || !event?.metadata) {
					console.error("Invalid event structure:", JSON.stringify(event));
					message.ack();
					continue;
				}

				// Skip started/queued events - no notification needed
				if (event.type.includes("started") || event.type.includes("queued")) {
					message.ack();
					continue;
				}

				const status = getBuildStatus(event);

				// Fetch additional data based on build status
				let previewUrl: string | null = null;
				let liveUrl: string | null = null;
				let logs: string[] = [];

				if (status.isSucceeded) {
					({ previewUrl, liveUrl } = await fetchBuildUrls(event, env));
				} else if (status.isFailed && !status.isCancelled) {
					logs = await fetchBuildLogs(event, env);
				}

				const payload = buildDiscordPayload(event, previewUrl, liveUrl, logs);
				await sendDiscordNotification(env.DISCORD_WEBHOOK_URL, payload);

				message.ack();
			} catch (error) {
				console.error("Error processing message:", error);
				message.ack();
			}
		}
	},
} satisfies ExportedHandler<Env, CloudflareEvent>;
