# Creating a Release for BRAT

Since you don't have GitHub CLI (`gh`) installed, here are two options:

## Why BRAT says "no manifest.json"

BRAT installs from your **latest GitHub Release**. It does not use the repo root or draft releases. If you see "This does not seem to be an obsidian plugin" or "manifest.json does not exist in the latest release", you need a **published** (non-draft) release that includes both `main.js` and `manifest.json`.

## Option 1: Publish the existing draft (quickest)

If you already pushed a tag (e.g. `2.0.6`), the GitHub Action created a **draft** release:

1. **Open Releases**: https://github.com/arcadesys/writersroom/releases
2. Find the **draft** release for the tag you want (e.g. `2.0.6`).
3. Click **Edit** (pencil) on that draft.
4. Click **Publish release** (not "Save draft").

BRAT will then see the release and install correctly.

## Option 1b: Create release via GitHub web (no tag yet)

1. **Go to your GitHub repository**: https://github.com/arcadesys/writersroom/releases/new

2. **Fill in the release form**:
   - **Tag**: Select or create tag (e.g. `2.0.6` to match `manifest.json`)
   - **Release title**: same as tag
   - **Description**: Optional (e.g. "BRAT beta")

3. **Upload the required files** (from your plugin folder):
   - `main.js` (run `npm run build` first if needed)
   - `manifest.json`

4. **Publish the release** (do not leave it as draft).

5. **Try BRAT again** — it should now find the release.

## Option 2: Install GitHub CLI and automate future releases

```bash
# Install GitHub CLI
brew install gh

# Authenticate
gh auth login

# Create the release
gh release create 0.1.0 \
  --title "0.1.0" \
  --notes "Initial beta release for BRAT" \
  main.js manifest.json
```

## For Future Releases

1. Update version in:
   - `manifest.json`
   - `manifest-beta.json` 
   - `package.json`

2. Commit and push changes

3. Create and push new tag:
   ```bash
   git tag 0.1.1
   git push origin 0.1.1
   ```

4. The GitHub Action should automatically create a draft release, or create it manually as above
