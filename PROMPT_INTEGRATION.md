# Writers Room Prompt

## Overview

Writers Room now orchestrates a crew of specialist “agents” whose instructions live in markdown files inside your vault (default folder: `WritersRoom Agents`). Each edit run combines those agents with a shared JSON schema so results stay consistent while the editorial tone remains flexible.

## Configuration

Required setting:

**OpenAI API Key** — store it in the plugin settings or via `WRITERSROOM_API_KEY`.

Optional settings:

- Agent prompt folder — where the plugin looks for agent `.md` files
- Default agent lineup — which agents are preselected when you ask the Writers

## How It Works

When you click **Ask the writers**:
1. The plugin reads the current note’s content.
2. You choose which agents (Flow, Lens, Punch, or your own prompts) should contribute.
3. Writers Room builds a composite system prompt from those agents plus the shared JSON instructions.
4. The request is sent to OpenAI’s `gpt-5` model via the Chat Completions API with streaming enabled.
5. Structured JSON edits stream back, are saved under the `edits/` folder, and highlights appear in the editor.

## Prompt Details

The bundled agents cover:
- **Flow** — sentence-level clarity, cadence, and transitions
- **Lens** — POV depth, interiority, and sensory texture
- **Punch** — emotional impact and energetic phrasing without melodrama

You can add additional agents by dropping new markdown files into the agent folder. Each file supports optional frontmatter (`id`, `label`, `description`, `order`) followed by the charter instructions.

## Edit Types

- **addition** — Suggests adding or expanding text
- **replacement** — Rewrites the snippet without changing its scope
- **star** — Calls out exemplary text worth keeping
- **subtraction** — Suggests removing or condensing text (`output` is `null`)
- **annotation** — Editorial comment or suggestion (`output` contains the note)

## Expected Output Format

```json
{
  "summary": "Brief editorial review",
  "edits": [
    {
      "agent": "flow",
      "line": 1,
      "type": "addition" | "replacement" | "star" | "subtraction" | "annotation",
      "category": "flow" | "lens" | "punch" | "your-agent-id",
      "original_text": "Exact text from the source document",
      "output": "Revised text or annotation comment (null for subtractions)"
    }
  ]
}
```

The `agent` field should match the specialist responsible for the change, and `category` mirrors that same identifier.

## Customizing the Prompt

To adjust editorial behaviour, edit or add agent prompt files in the configured agent folder. No code changes are required; updating the markdown instructions automatically refreshes the crew after saving the file. Use the plugin settings to point at a different folder or change which agents run by default.
