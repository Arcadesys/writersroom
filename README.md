# Writers Room

An Obsidian plugin that integrates ChatGPT prompts directly into your notes, allowing you to call prompts by ID and visualize AI-suggested edits with syntax highlighting.

## Features

- 📝 Call ChatGPT prompts using custom prompt IDs
- ✨ Highlight and visualize AI-suggested edits in your markdown
- 🎨 Color-coded edit annotations (additions, deletions, replacements)
- 🔄 Streaming responses with real-time updates

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
3. Configure your prompt settings and preferences

## Usage

*(Coming soon - plugin is currently in development)*

- Use prompt IDs to call specific ChatGPT prompts
- View highlighted edits in your markdown files
- Accept or reject suggested changes

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
