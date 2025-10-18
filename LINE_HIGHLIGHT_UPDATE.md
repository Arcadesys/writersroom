# Line-Based Highlight Update

## Summary

Updated the Writers Room plugin to highlight entire lines as visual units in edit mode, while allowing natural cursor placement on click.

## Changes Made

### 1. **Decoration Type Change** (`buildEditorHighlightDecorations`)
- **Before**: Used `Decoration.mark()` for inline text highlighting
- **After**: Uses `Decoration.line()` to highlight entire line elements as units
- **Benefit**: Creates a unified visual element per line, making highlights more cohesive and easier to see

### 2. **Click Handling** (`WritersRoomViewPlugin`)
- **Before**: Global click handler prevented default behavior, blocking cursor placement
- **After**: CodeMirror `mousedown` event handler that:
  - Detects clicks on highlighted lines
  - **Allows default cursor placement** (returns `false`)
  - Asynchronously syncs selection to sidebar after cursor placement
- **Benefit**: User can click anywhere in a highlighted line and the cursor appears exactly where they clicked

### 3. **Cursor Positioning** (`scrollEditorsToAnchor`)
- **New parameter**: `origin: SelectionOrigin` to distinguish click source
- **Sidebar clicks**: Cursor moves to **line start** (column 0)
- **Editor clicks**: Cursor stays at **click position** (natural behavior)
- **Benefit**: Clear, consistent behavior based on interaction origin

### 4. **CSS Updates** (`buildWritersRoomCss`)
- **Before**: Styled inline mark decorations
- **After**: Styles `.cm-line` elements with:
  - Subtle background colors for each edit type
  - Left border indicators (colored by type)
  - Hover states for interactivity
  - Active state with enhanced border
- **Benefit**: Clean, editor-native appearance that doesn't interfere with text layout

### 5. **Global Click Handler Update**
- **Before**: Handled all clicks on `[data-writersroom-anchor]` elements
- **After**: Only handles **preview mode** clicks
- Skips elements marked with `data-wr-bound="editor"`
- **Benefit**: Prevents conflicts between preview and edit mode handlers

## Behavior Flow

### Editor Click Flow
```
User clicks inside highlighted line
  ↓
CodeMirror places cursor at click position (default behavior)
  ↓
mousedown handler detects click on highlighted line
  ↓
Handler returns false (allows default)
  ↓
setTimeout schedules sync (after cursor placement)
  ↓
handleAnchorClick syncs sidebar and highlights
```

### Sidebar Click Flow
```
User clicks edit in sidebar
  ↓
selectEdit called with origin="sidebar"
  ↓
setActiveHighlight receives origin
  ↓
scrollEditorsToAnchor positions cursor at line start
  ↓
Sidebar selection and highlights sync
```

## Technical Details

### Plugin Instance Registration
- Plugin instance stored globally: `window.writersRoomPlugin`
- Allows CodeMirror event handlers to call plugin methods
- Cleaned up in `onunload()`

### Line Decoration Deduplication
- Multiple specs for same line are consolidated
- Only first decoration per line position is applied
- Prevents visual conflicts and performance issues

## Testing Checklist

- [x] Build succeeds without errors
- [ ] Lines highlight as cohesive visual units
- [ ] Clicking inside highlighted line places cursor at click position
- [ ] Clicking edit in sidebar moves cursor to line start
- [ ] Sidebar syncs selection when clicking in editor
- [ ] Edit mode and preview mode highlights work independently
- [ ] Active highlight styling appears correctly
- [ ] Different edit types show distinct colors

## Files Modified

- `main.ts`:
  - `buildEditorHighlightDecorations()` - Changed to line decorations
  - `WritersRoomViewPlugin` - Added event handlers
  - `handleAnchorClick()` - Made public
  - `selectEdit()` - Pass origin through
  - `setActiveHighlight()` - Handle origin parameter
  - `scrollEditorsToAnchor()` - Position cursor based on origin
  - `buildWritersRoomCss()` - Updated CSS for line decorations
  - `onload()` - Register plugin globally
  - `onunload()` - Clean up global registration
  - Global click handler - Skip editor-bound elements
