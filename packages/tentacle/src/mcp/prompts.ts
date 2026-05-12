/**
 * System-prompt hint appended to Copilot sessions so the model knows when to
 * use the Kraki MCP `show_image` tool vs the built-in `view`/`read` tools.
 *
 * Exported as a constant so tests can assert the text is wired through.
 */
export const SYSTEM_PROMPT_HINT = `\
You have access to a Kraki MCP server with tools prefixed by "kraki.".

When you want to visually present an image to the user — a screenshot you \
captured, a diagram you generated, a chart, a UI mock — call \
\`kraki.show_image\` with the absolute file path. Use it sparingly: only \
when the user benefits from seeing the actual pixels.

Plain file viewing on image files (with \`view\`/\`read\`) is for your own \
inspection; those appear as collapsed attachments in the chat. Use \
\`kraki.show_image\` when the user should actually see the image inline.\
`;
