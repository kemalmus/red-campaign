/* Channel name only — never put the webhook key in this file. */
export const NTFY_TOPIC = "red-campaign-GIvOGMwxRjrw1zbzUSI-X2wh4wWDeGAg";
export const NTFY_BASE = "https://ntfy.sh";
export const KALE_MODEL = "https://huggingface.co/KaleComputer/kale-tts-1-nano/resolve/main/";
export const KALE_FRONTEND = "https://huggingface.co/KaleComputer/kale-tts-1-nano/resolve/main/frontend/";
export const DEFAULT_VOICE = "magnus";

// Cloudflare Worker relay. Empty = send through ntfy + box relay (current path).
// Set to the deployed Worker URL (no trailing slash) only after it is verified.
export const WORKER_URL = "";
