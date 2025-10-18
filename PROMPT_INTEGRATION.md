# OpenAI Prompt Integration

## Overview

The plugin now uses OpenAI's Prompt API instead of storing prompts in code. This allows you to version and manage your prompts directly in the OpenAI platform.

## Configuration

The plugin now has three settings:

1. **OpenAI API Key** - Your OpenAI API key (can also be set via `WRITERSROOM_API_KEY` environment variable)
2. **Prompt ID** - The ID of your prompt from the OpenAI Prompt Library (e.g., `pmpt_68ee82bd4d348197bf7620d91cfebde40ff924f946984331`)
3. **Prompt Version** - The version number of the prompt to use (e.g., `4`)

## Prompt Variables

The plugin passes the following variables to your prompt:

- `title` - The basename of the current note (without extension)
- `user_text` - The full markdown content of the note

## Expected Prompt Output

Your prompt should return a JSON object with the following structure:

```json
{
  "summary": "Brief summary of the edits",
  "edits": [
    {
      "agent": "editor",
      "line": 1,
      "type": "addition" | "subtraction" | "annotation",
      "category": "flow" | "rhythm" | "sensory" | "punch",
      "original_text": "The text from the source document",
      "output": "Revised text or annotation comment"
    }
  ]
}
```

### Edit Types

- **addition** - Suggests adding or expanding text. `output` contains the revised text.
- **subtraction** - Suggests removing or condensing text. `output` contains the revised text.
- **annotation** - Editorial comment or suggestion. `output` contains the comment text.

## Migration from Previous Version

The previous version stored the prompt instructions directly in the code. The new version uses the OpenAI Prompt API with these default values:

- Default Prompt ID: `pmpt_68ee82bd4d348197bf7620d91cfebde40ff924f946984331`

You can change these in the plugin settings.
