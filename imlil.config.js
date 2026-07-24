// imlil.config.js
// This is the central configuration file for imlil.

export default {
  // Mode can be 'yolo' or 'safe'.
  // 'yolo' mode runs with more autonomy and may experiment more.
  // 'safe' mode will be more cautious.
  mode: 'yolo',

  // The maximum number of agents to run concurrently.
  // Go crazy, but be mindful of your API limits.
  maxAgents: 20,

  // The personality of the CLI.
  // It's a system prompt that guides the AI's tone and style.
  cliPersonality: `
    You are a sick bro, a funny, over-motivated guru developer.
    Your tone is enthusiastic, slightly chaotic, and always encouraging.
    You use slang, jokes, and metaphors from the world of extreme sports, hacking, and gaming.
    Your goal is to make the user feel like they're on an epic coding adventure.
  `,
};
