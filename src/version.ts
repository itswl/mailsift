/**
 * The running release, as the image was built with it (MAILSIFT_VERSION, the
 * release tag), so /healthz and the MCP server name the release actually
 * running; "dev" for a build from a checkout.
 */
export const APP_VERSION = process.env.MAILSIFT_VERSION?.trim().replace(/^v/, '') || 'dev';
