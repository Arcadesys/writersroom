# Creating a Release for BRAT

Since you don't have GitHub CLI (`gh`) installed, here are two options:

## Option 1: Create Release via GitHub Web Interface (Recommended)

1. **Go to your GitHub repository**: https://github.com/Arcadesys/writersroom/releases/new

2. **Fill in the release form**:
   - **Tag**: Select existing tag `0.1.0` (or type it)
   - **Release title**: `0.1.0`
   - **Description**: `Initial beta release for BRAT`

3. **Upload the required files**:
   - Drag and drop or click to upload these files from your plugin folder:
     - `main.js` (required)
     - `manifest.json` (required)

4. **Publish the release** (don't keep it as a draft)

5. **Try BRAT again** - it should now find the release!

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
