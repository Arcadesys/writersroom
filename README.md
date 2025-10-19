# Writers Room

An Obsidian plugin that integrates ChatGPT prompts directly into your notes, allowing you to call prompts by ID and visualize AI-suggested edits with syntax highlighting.

## Features

- 🧩 Compose edit runs from individual “agents” (Flow, Lens, Punch) or your own prompt files
- 📝 Call ChatGPT prompts using custom prompt IDs directly from Obsidian
- ✨ Highlight and visualize AI-suggested edits in your markdown
- 🎨 Color-coded edit annotations (additions, deletions, replacements)
- 🔄 Streaming responses with real-time updates and progress logs

## Installation via BRAT

Since this plugin is currently in development and not yet available in the Obsidian Community Plugins directory, you can install it using [BRAT (Beta Reviewers Auto-update Tester)](https://github.com/TfTHacker/obsidian42-brat).

### Step 1: Install BRAT

1. Open Obsidian Settings
2. Go to **Community Plugins** and disable Safe Mode if needed
3. Click **Browse** and search for "BRAT"
4. Install **Obsidian42 - BRAT** and enable it

### Step 2: Add Writers Room via BRAT

1. Open Obsidian Settings
2. Go to **BRAT** settings (under Community Plugins)
3. Click **Add Beta Plugin**
4. Enter the repository URL: `Arcadesys/writersroom`
5. Click **Add Plugin**
6. Wait for BRAT to download and install the plugin

### Step 3: Enable Writers Room

1. Go to **Settings** → **Community Plugins**
2. Find "Writers Room" in your plugin list
3. Toggle it on to enable

BRAT will automatically check for updates and keep your plugin up to date!

## Configuration

After enabling the plugin, configure your settings:

1. Go to **Settings** → **Writers Room**
2. Add your OpenAI API key
3. Configure your prompt settings and preferences:
   - Choose the vault folder that stores agent prompt files (defaults to `WritersRoom Agents`)
   - Pick the default agent lineup that runs when you ask the Writers
   - Adjust highlight colours and audible feedback to taste

## Agent prompts

When the plugin loads it creates a folder called `WritersRoom Agents` (or the folder you specify). Each markdown file inside that folder becomes a specialist agent you can call during an edit pass.

The built-in crew includes:

- `flow.md` — smooth sentence-level clarity and cadence
- `lens.md` — deepen POV, interiority, and sensory texture
- `punch.md` — heighten emotional impact without tipping into melodrama

Each prompt file supports simple frontmatter:

```yaml
---
id: flow
label: Flow
description: Smooth sentence-level clarity, cadence, and transitions.
order: 1
---
You are the Flow editor...
```

Only the body text is required; `id`, `label`, `description`, and `order` help with menus and ordering. Add new files or edit the defaults to tune the crew to your style.

## Usage

### Ask the Writers for a full pass

1. Open the note you want to revise.
2. Run **Command Palette → Writers Room: Ask the Writers for edits**.
3. Choose the agents you want for this pass (Flow/Lens/Punch or your custom prompts).
4. Wait for the streaming response. Progress updates and the model’s reasoning appear in the sidebar.
5. Review the highlighted edits, accept or reject them, and iterate as needed.

### Quick prompts on a selection

- Select text in any note and run **Command Palette → Writers Room: Run quick prompt on selection**.
- Choose from specialist quick prompts (Flow/Lens/Punch), the full crew, or other utilities like “Punch up this line”.
- Results appear in a modal with copy-to-clipboard helpers.

### Customising the crew

- Edit the markdown prompt files in your agent folder to tweak instructions.
- Add new `.md` files to introduce additional agents—each file is an independent specialist.
- Use the Writers Room settings tab to set the default lineup that appears preselected in the agent picker.

## Development

### Building from Source

```bash
# Clone the repository
git clone https://github.com/Arcadesys/writersroom.git

# Navigate to the plugin directory
cd writersroom

# Install dependencies
npm install

# Build the plugin
npm run build

# Or run in development mode with auto-rebuild
npm run dev
```

### Testing

```bash
npm test
```

## Requirements

- Obsidian v1.5.0 or higher
- OpenAI API key

## License

MIT

## Support

This plugin is currently a work in progress. If you encounter any issues or have feature requests, please open an issue on GitHub.

## Author

Austen

---

**Note:** This plugin is in active development. Features and functionality may change.
