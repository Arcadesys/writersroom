# Writers Room Prompt

## Overview

The plugin uses OpenAI's Chat Completions API with a built-in prompt to generate editorial suggestions. The prompt is stored in `writersprompt.md` for reference and versioning.

## Configuration

The plugin only requires one setting:

**OpenAI API Key** - Your OpenAI API key (can also be set via `WRITERSROOM_API_KEY` environment variable)

## How It Works

When you click "Ask the writers", the plugin:
1. Reads your current note's content
2. Sends it to OpenAI's `gpt-4o-mini` model with the editorial prompt
3. Receives structured JSON edits back
4. Stores them in an `edits/` folder
5. Displays highlights in the editor and edits in the sidebar

## Prompt Details

The prompt instructs the AI to act as a line-level prose editor specializing in:
- **flow** — smoothness and clarity of sentences
- **rhythm** — pacing and variation in sentence/phrase length
- **sensory** — imagery, tangible physical details
- **punch** — emotional impact or added emphasis

## Edit Types

- **addition** - Suggests adding or expanding text
- **subtraction** - Suggests removing or condensing text (output is null)
- **annotation** - Editorial comment or suggestion (output contains the comment)

## Expected Output Format

```json
{
  "summary": "Brief editorial review",
  "edits": [
    {
      "agent": "editor",
      "line": 1,
      "type": "addition" | "subtraction" | "annotation",
      "category": "flow" | "rhythm" | "sensory" | "punch",
      "original_text": "Text from the source document",
      "output": "Revised text or annotation comment (null for subtractions)"
    }
  ]
}
```

## Customizing the Prompt

To modify the editorial instructions, edit the `systemPrompt` variable in the `requestAiEditsForFile` method in `main.ts`. The current prompt is based on `writersprompt.md`.
